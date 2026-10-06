import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CwosMasterReader } from '../src/adapters/cwos-master-reader.js';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { MailWorkIntakeService } from '../src/application/mail-work-intake.js';

const root = process.argv[2];
assert(root, 'Existing CRM producer path is required');
const admission = JSON.parse(await readFile(join(root, '.omo/evidence/fp5-crm-r1-local-v2.json'), 'utf8'));
assert.equal(admission.artifactVersion, 'CRM-R1-local-v2');
// These three subsequent read-only hardening files are separately observed;
// never claim that their changed bytes are covered by the old R1 eight pins.
const sourcePins = {
  ...admission.source.files,
  'apps/api/src/app.ts': '437e0f40abc39e147d488e0ffc47a4c469eeaaa303be656e7d89c66fd3ce6e93',
  'apps/api/test/customer-work-os-v2-auth.security.test.ts': 'b1715c1e392b633aef1087a6abb9ac4ad7b2eb75c0a27cb7d79f1e830ce9b401',
  'apps/api/test/customer-work-os-v2-normalized-projection.livepg.integration.test.ts': 'c68b6566a8e2741d496d5faf13a49b72ec88f025e8540b466fc168d81c5cd50d',
};
async function assertPins() {
  for (const [file, expected] of Object.entries(sourcePins)) {
    assert.equal(createHash('sha256').update(await readFile(join(root, file))).digest('hex'), expected, file);
  }
}
await assertPins();
const { createApp } = await import(pathToFileURL(join(root, 'apps/api/src/app.ts')));
const { PgCwosV2StateStore } = await import(pathToFileURL(join(root, 'apps/api/src/customer-work-os-v2-runtime.ts')));
const { default: pg } = await import(pathToFileURL(join(root, 'apps/api/node_modules/pg/lib/index.js')));
const run = promisify(execFile);
const inspected = await run('docker', ['inspect', '--format', '{{json .Config.Env}}', 'core5-crm-pilot-pg'], { timeout: 10_000 });
const settings = new Map(JSON.parse(inspected.stdout).map(line => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1)];
}));
const mapped = await run('docker', ['port', 'core5-crm-pilot-pg', '5432/tcp'], { timeout: 10_000 });
const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapped.stdout)?.[1];
assert(port);
const config = { host: '127.0.0.1', port: Number(port), user: settings.get('POSTGRES_USER'), password: settings.get('POSTGRES_PASSWORD') };
assert(config.user && config.password);
const admin = new pg.Pool({ ...config, database: 'postgres' });
const database = `fp5_mail_v2_reader_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'mail-fp5-v2-reader-'));
const workspaceId = randomUUID();
const human = { workspaceId, principalId: 'reader-fixture-human', kind: 'human', stepUpVerified: true };
const machine = { workspaceId, principalId: 'reader-fixture-service', kind: 'service', readOnly: true };
const humanKey = randomBytes(32).toString('hex');
const machineKey = randomBytes(32).toString('hex');
const planId = 'mail-reader-fixture-plan';
const now = '2026-10-06T00:00:00.000Z';
let created = false;
let db;
let mailStore;
const apps = [];
const calls = [];
try {
  // Identical owned scratch-template lifecycle to admitted CRM R1/RS.
  // Only normalized synthetic archive fixture rows are initialized with SQL.
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ai_crm_dryrun_20260930`);
  created = true;
  db = new pg.Pool({ ...config, database });
  await db.query('INSERT INTO workspaces(id,name) VALUES($1,\'Mail v2 reader explicit fixture\')', [workspaceId]);
  const scoped = {
    async query(sql, args) { return db.query(sql, args); },
    async withWorkspaceScope(ws, action) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE ai_crm_runtime_api');
        await client.query('SELECT set_config(\'app.workspace_id\',$1,true)', [ws]);
        const result = await action({ query: (sql, args) => client.query(sql, args) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
  };
  const humanApp = createApp({ authApiKey: humanKey, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2ActorBinding: human, customerWorkOsV2NormalizedProjectionPool: scoped });
  const readerApp = createApp({ authApiKey: machineKey, customerWorkOsV2Store: new PgCwosV2StateStore(scoped),
    customerWorkOsV2MachineBinding: machine, customerWorkOsV2NormalizedProjectionPool: scoped });
  apps.push(humanApp, readerApp);
  await Promise.all(apps.map(app => app.ready()));
  const headers = { 'x-api-key': humanKey, 'x-workspace-id': workspaceId, 'x-principal-id': human.principalId, 'x-principal-kind': 'human' };
  for (const [command, payload] of [
    ['identity.registerPrincipal', { id: human.principalId, kind: 'human', displayName: 'Explicit fixture human', active: true }],
    ['identity.addMembership', { id: 'reader-human-member', principalId: human.principalId }],
    ['identity.registerPrincipal', { id: machine.principalId, kind: 'service', displayName: 'Explicit fixture reader', active: true }],
    ['identity.addMembership', { id: 'reader-service-member', principalId: machine.principalId }],
    ['admin.provision', { id: workspaceId, name: 'Explicit owned reader workspace',
      quotaUsers: 1, quotaStorageMb: 1, retentionDays: 1, templateVersion: 'ISOLATED_ONLY' }],
  ]) {
    const state = (await humanApp.inject({ method: 'GET', url: '/api/cwos/v2/state', headers })).json();
    const result = await humanApp.inject({ method: 'POST', url: '/api/cwos/v2/commands', headers: {
      ...headers, 'idempotency-key': `reader-bootstrap:${payload.id}`,
    }, payload: { command, payload, expectedVersion: state.version } });
    assert.equal(result.statusCode, 200, result.body);
  }
  await db.query(`INSERT INTO cwos_accounts(id,workspace_id,name,normalized_name,kinds,status)
    VALUES('reader-account',$1,'Archive Fixture Company','archive fixture company','["customer"]','active')`, [workspaceId]);
  await db.query(`INSERT INTO cwos_accounts(id,workspace_id,name,normalized_name,kinds,status,source_ref)
    VALUES('reader-excluded',$1,'Quarantined Company','quarantined company','["customer"]','active','notion://reader-quarantined')`, [workspaceId]);
  await db.query(`INSERT INTO cwos_engagements(id,workspace_id,project_key,name,engagement_type,stage,health,owner_principal_id)
    VALUES('reader-engagement',$1,'READER-1','Archive Fixture Project','opportunity','PROPOSAL','normal',$2)`, [workspaceId, human.principalId]);
  await db.query(`INSERT INTO cwos_financial_items(id,workspace_id,account_id,direction,category,lifecycle,
    net_amount_krw,vat_amount_krw,gross_amount_krw,expected_date)
    VALUES('reader-finance',$1,'reader-account','OUT','overhead','PLANNED',9007199254740993,0,9007199254740993,'2026-10-06')`, [workspaceId]);
  const plan = { workspaceId, snapshotId: 'reader-snapshot', capturedAt: now,
    accounts: [{ id: 'reader-account' }, { id: 'reader-excluded' }], engagements: [{ id: 'reader-engagement' }],
    financialItems: [{ id: 'reader-finance' }], quarantined: [{ sourceId: 'reader-quarantined' }] };
  const snapshotHash = `sha256:${createHash('sha256').update(JSON.stringify(plan)).digest('hex')}`;
  const planHash = `sha256:${createHash('sha256').update(JSON.stringify({ planId, plan })).digest('hex')}`;
  await db.query(`INSERT INTO cwos_notion_import_plans(id,workspace_id,snapshot_id,snapshot_hash,plan_hash,captured_at,
    plan,source_counts,imported_counts,finance_totals,quarantine_count,orphan_relation_count,duplicate_candidate_count,
    status,read_only_source,created_by_principal_id,approved_by_principal_id,applied_by_principal_id,approved_at,applied_at)
    VALUES($1,$2,'reader-snapshot',$3,$4,$5,$6,'{}','{}','{}',1,0,0,
    'APPLIED',true,$7,$7,$7,$5,$5)`, [planId, workspaceId, snapshotHash, planHash, now, JSON.stringify(plan), human.principalId]);
  const prior = (await humanApp.inject({ method: 'GET', url: '/api/cwos/v2/state', headers })).json();
  const reference = await humanApp.inject({ method: 'POST', url: '/api/cwos/v2/commands', headers: {
    ...headers, 'idempotency-key': 'reader-unapproved-reference',
  }, payload: { command: 'business.reconcileNormalized', payload: { planId }, expectedVersion: prior.version } });
  assert.equal(reference.statusCode, 200, reference.body);
  assert.equal(reference.json().result.approved, false);
  const before = (await humanApp.inject({ method: 'GET', url: '/api/cwos/v2/state', headers })).json();
  const beforeAudit = (await db.query('SELECT * FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows;
  const beforeMoney = (await db.query('SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows;
  assert.equal(beforeMoney[0].net_amount_krw, '9007199254740993');
  const bridge = async (url, options) => {
    const response = await readerApp.inject({ method: options.method, url: url.pathname + url.search, headers: options.headers });
    if (response.statusCode === 200 && url.pathname.includes('/normalized-projections/')) {
      assert.equal(response.json().financialItems[0].net_amount_krw, '9007199254740993');
    }
    calls.push({ method: options.method, path: url.pathname, status: response.statusCode });
    return new Response(response.body, { status: response.statusCode });
  };
  const reader = new CwosMasterReader({ baseUrl: 'http://127.0.0.1', credential: machineKey, ...machine, planId, fetchImpl: bridge });
  const read = await reader.readMasters({ workspaceId });
  assert.deepEqual(read.items.map(item => item.externalId), ['reader-account', 'reader-engagement']);
  assert.equal(read.items[1].type, 'opportunity');
  assert.equal(read.provenance.sourceDigest, reference.json().result.sourceDigest);
  assert.equal(read.provenance.runtimeVersion, before.version);
  for (const item of read.items) {
    assert.equal(item.status, 'candidate');
    assert.equal(item.source.authority, 'ARCHIVE_PROJECTION_ONLY');
    assert.equal(item.source.recordKind, 'ARCHIVE_REFERENCES');
    assert.equal(item.source.approved, false);
    assert.equal(item.source.nativeWork, false);
  }
  mailStore = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), now: () => now });
  const mailbox = mailStore.ensureMailbox({ key: 'reader@example.invalid' });
  const folder = mailStore.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  mailStore.applyDeltaPage({ mailboxId: mailbox.id, folderId: folder.id,
    syncRunId: mailStore.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }),
    pageIndex: 0, deltaLink: 'https://graph.microsoft.com/fixture/reader',
    items: [normalizeGraphMessage({ id: 'reader-mail', changeKey: 'reader-v1', conversationId: 'reader-thread',
      subject: 'Archive Fixture Company: Archive Fixture Project READER-1 quote request',
      receivedDateTime: now, from: { emailAddress: { address: 'sender@example.invalid' } },
      body: { contentType: 'text', content: 'Review Archive Fixture Project READER-1.' } })] });
  const intake = new MailWorkIntakeService({ store: mailStore, workSystem: new CwosWorkSystemAdapter({ db: mailStore.db, cwosClient: reader }) });
  const received = await intake.ingest('reader@example.invalid', 'reader-mail', { workspaceId });
  const candidates = [...received.customer.candidates, ...received.project.candidates];
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.status, 'candidate');
    const evidence = candidate.evidence.find(item => item.kind === 'cwos_source');
    assert.equal(evidence.planId, planId);
    assert.equal(evidence.sourceDigest, reference.json().result.sourceDigest);
    assert.equal(evidence.approved, false);
    assert.equal(evidence.nativeWork, false);
  }
  const replay = await intake.ingest('reader@example.invalid', 'reader-mail', { workspaceId });
  assert.deepEqual(replay.customer.candidates.map(c => c.id), received.customer.candidates.map(c => c.id));
  assert.deepEqual(replay.project.candidates.map(c => c.id), received.project.candidates.map(c => c.id));
  mailStore.close();
  mailStore = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), now: () => now });
  const reopened = new MailWorkIntakeService({ store: mailStore }).get('reader@example.invalid', 'reader-mail');
  assert.deepEqual(reopened.customer.candidates, replay.customer.candidates);
  assert.deepEqual(reopened.project.candidates, replay.project.candidates);
  const count = calls.length;
  await assert.rejects(reader.readMasters({ workspaceId: randomUUID() }), { code: 'CWOS_WORKSPACE_NOT_BOUND' });
  await assert.rejects(reader.readMasters({ workspaceId, principalId: human.principalId }), { code: 'CWOS_PRINCIPAL_NOT_BOUND' });
  assert.equal(calls.length, count);
  const badReader = new CwosMasterReader({ baseUrl: 'http://127.0.0.1', credential: machineKey, workspaceId,
    principalId: 'forged-reader', kind: 'service', planId, fetchImpl: bridge });
  await assert.rejects(badReader.readMasters({ workspaceId }), { code: 'CWOS_UNAUTHENTICATED' });
  const machineHeaders = { 'x-api-key': machineKey, 'x-workspace-id': workspaceId,
    'x-principal-id': machine.principalId, 'x-principal-kind': machine.kind };
  const mutationDenied = await readerApp.inject({ method: 'POST', url: '/api/cwos/v2/commands', headers: machineHeaders,
    payload: { command: 'business.reconcileNormalized', expectedVersion: before.version, payload: { planId } } });
  assert.equal(mutationDenied.statusCode, 403);
  assert.equal(mutationDenied.json().error, 'MACHINE_READ_ONLY');
  const legacyDenied = await readerApp.inject({ method: 'GET', url: '/api/cwos/accounts', headers: machineHeaders });
  assert.equal(legacyDenied.statusCode, 403);
  assert.deepEqual((await humanApp.inject({ method: 'GET', url: '/api/cwos/v2/state', headers })).json(), before);
  assert.deepEqual((await db.query('SELECT * FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows, beforeAudit);
  assert.deepEqual((await db.query('SELECT * FROM cwos_financial_items WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows, beforeMoney);
  assert(calls.every(call => call.method === 'GET' && call.path.startsWith('/api/cwos/v2/')));
  await assertPins();
  console.log(JSON.stringify({ level: 'EXPLICIT_OWNED_FIXTURE_ONLY', channel: 'MAINTAINED_FASTIFY_HTTP_REAL_PG_NO_LISTENER',
    database, workspaceId, planId, sourcePins, originalR1PinsMatched: 5, freshReadOnlyPins: 3,
    version: before.version, sourceDigest: read.provenance.sourceDigest, authority: 'ARCHIVE_PROJECTION_ONLY',
    approved: false, nativeWork: false, candidates: candidates.length, nativeHttpCalls: calls.length,
    replay: 'unchanged', persistedReread: 'unchanged', quarantinedExcluded: true,
    sourceMoney: '9007199254740993', nativeStateAuditMoney: 'unchanged', denials: 5 }, null, 2));
} finally {
  for (const app of apps) await app.close();
  mailStore?.close();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  await assert.rejects(access(directory), { code: 'ENOENT' });
  console.log('MAIL_CWOS_V2_READER_CLEANUP_OK');
}
