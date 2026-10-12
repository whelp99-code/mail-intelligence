import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { MailWorkIntakeService } from '../src/application/mail-work-intake.js';
import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';
import { CwosMailCommandClient, mailSourceDigest } from '../src/adapters/cwos-mail-command.js';

const root = process.argv[2];
assert(root, 'An admitted CRM checkout is required');
const receipt = JSON.parse(await readFile(join(root, '.omo/evidence/fp5-crm-r1-local-v2.json'), 'utf8'));
assert.equal(receipt.artifactVersion, 'CRM-R1-local-v2');
for (const [file, expected] of Object.entries(receipt.source.files)) {
  assert.equal(createHash('sha256').update(await readFile(join(root, file))).digest('hex'), expected, file);
}
const { createApp } = await import(pathToFileURL(join(root, 'apps/api/src/app.ts')));
const { PgCwosV2StateStore, CustomerWorkOsV2RuntimeManager } = await import(
  pathToFileURL(join(root, 'apps/api/src/customer-work-os-v2-runtime.ts')));
const { default: pg } = await import(pathToFileURL(join(root, 'apps/api/node_modules/pg/lib/index.js')));
const { Pool } = pg;
const run = promisify(execFile);
const inspected = await run('docker', ['inspect', '--format', '{{json .Config.Env}}', 'core5-crm-pilot-pg'], { timeout: 10_000 });
const settings = new Map(JSON.parse(inspected.stdout).map((line) => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));
const mapped = await run('docker', ['port', 'core5-crm-pilot-pg', '5432/tcp'], { timeout: 10_000 });
const port = /(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(mapped.stdout)?.[1];
assert(port);
const config = {
  host: '127.0.0.1', port: Number(port),
  user: settings.get('POSTGRES_USER'), password: settings.get('POSTGRES_PASSWORD'),
};
assert(config.user && config.password);
const admin = new Pool({ ...config, database: 'postgres' });
const database = `fp5_mail_mr_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(join(tmpdir(), 'mail-fp5-mr-'));
const workspaceId = randomUUID();
const machine = { workspaceId, principalId: 'mail-fixture-service', kind: 'service' };
const human = { workspaceId, principalId: 'mail-fixture-human', kind: 'human', stepUpVerified: true };
const machineKey = randomBytes(32).toString('hex');
const humanKey = randomBytes(32).toString('hex');
let created = false;
let db;
let store;
const apps = [];
const calls = [];
const clock = () => '2026-10-06T00:00:00.000Z';

try {
  // Fixture lifecycle only. All business records below are created by native HTTP commands.
  await admin.query(`CREATE DATABASE ${database} TEMPLATE ai_crm_dryrun_20260930`);
  created = true;
  db = new Pool({ ...config, database });
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
  const humanApp = createApp({ authApiKey: humanKey, customerWorkOsV2Store: new PgCwosV2StateStore(scoped), customerWorkOsV2ActorBinding: human });
  const machineApp = createApp({ authApiKey: machineKey, customerWorkOsV2Store: new PgCwosV2StateStore(scoped), customerWorkOsV2MachineBinding: machine });
  apps.push(humanApp, machineApp);
  await Promise.all(apps.map(app => app.ready()));
  const humanHeaders = {
    'x-api-key': humanKey, 'x-workspace-id': workspaceId,
    'x-principal-id': human.principalId, 'x-principal-kind': 'human',
  };
  const machineHeaders = {
    'x-api-key': machineKey, 'x-workspace-id': workspaceId,
    'x-principal-id': machine.principalId, 'x-principal-kind': 'service',
  };
  for (const [command, payload] of [
    ['identity.registerPrincipal', { id: human.principalId, kind: 'human', displayName: 'Explicit fixture owner', active: true }],
    ['identity.addMembership', { id: 'human-member', principalId: human.principalId }],
    ['identity.registerPrincipal', { id: machine.principalId, kind: 'service', displayName: 'Explicit fixture service', active: true }],
    ['identity.addMembership', { id: 'machine-member', principalId: machine.principalId }],
  ]) {
    const state = (await humanApp.inject({ method: 'GET', url: '/api/cwos/v2/state', headers: humanHeaders })).json();
    const response = await humanApp.inject({
      method: 'POST', url: '/api/cwos/v2/commands',
      headers: { ...humanHeaders, 'idempotency-key': `fixture-bootstrap:${payload.id}` },
      payload: { command, payload, expectedVersion: state.version },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const bridge = app => async (url, options) => {
    const response = await app.inject({
      method: options.method, url: url.pathname + url.search, headers: options.headers,
      ...(options.body ? { payload: options.body } : {}),
    });
    calls.push({ method: options.method, path: url.pathname, status: response.statusCode });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const machineClient = new CwosMailCommandClient({
    baseUrl: 'http://127.0.0.1', apiKey: machineKey, ...machine, fetchImpl: bridge(machineApp),
  });
  const humanClient = new CwosMailCommandClient({
    baseUrl: 'http://127.0.0.1', apiKey: humanKey, ...human, fetchImpl: bridge(humanApp),
  });
  store = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), now: clock });
  const mailboxUser = 'fixture@example.invalid';
  const mailbox = store.ensureMailbox({ key: mailboxUser });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  store.applyDeltaPage({
    mailboxId: mailbox.id, folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }), pageIndex: 0,
    items: [normalizeGraphMessage({
      id: 'mr-source', internetMessageId: '<mr-source@example.invalid>', conversationId: 'mr-thread',
      changeKey: 'mr-source-v1', subject: 'Synthetic work candidate', receivedDateTime: '2026-09-01T03:00:00.000Z',
      from: { emailAddress: { address: 'sender@example.invalid' } },
      body: { contentType: 'text', content: '  Explicit synthetic work evidence.\n' },
      attachments: [{ id: 'mr-attachment', name: 'source.csv', contentType: 'text/csv', size: 42,
        lastModifiedDateTime: '2026-09-01T02:00:00.000Z' }],
    })],
    deltaLink: 'https://graph.microsoft.com/fixture/mr',
  });
  const workSystem = new CwosWorkSystemAdapter({ db: store.db, commandClient: machineClient });
  const intake = new MailWorkIntakeService({ store, workSystem });
  const original = intake.source(mailboxUser, 'mr-source').source;
  const before = await machineClient.readState(workspaceId);
  const receive = await intake.receiveInCrm(mailboxUser, 'mr-source', { workspaceId, expectedVersion: before.version });
  assert.equal(receive.result.receivedAt, original.receivedAt);
  const firstAudit = (await db.query('SELECT * FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows;
  const replay = await intake.receiveInCrm(mailboxUser, 'mr-source', { workspaceId, expectedVersion: 0 });
  assert.deepEqual(replay, receive);
  assert.deepEqual((await db.query('SELECT * FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows, firstAudit);
  const transport = machineClient.fetchImpl;
  machineClient.fetchImpl = async (...args) => {
    await transport(...args);
    throw Object.assign(new Error('FIXTURE_RESPONSE_LOST'), { code: 'FIXTURE_RESPONSE_LOST' });
  };
  await assert.rejects(intake.receiveInCrm(mailboxUser, 'mr-source', { workspaceId, expectedVersion: 0 }),
    { code: 'FIXTURE_RESPONSE_LOST' });
  machineClient.fetchImpl = transport;
  assert.deepEqual(await intake.receiveInCrm(mailboxUser, 'mr-source', { workspaceId, expectedVersion: 0 }), receive);
  assert.deepEqual((await db.query('SELECT * FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows, firstAudit);
  assert.equal((await db.query('SELECT count(*) AS n FROM cwos_v2_mail_inbox_receipts WHERE workspace_id=$1', [workspaceId])).rows[0].n, '1');
  assert.equal((await machineClient.readState(workspaceId)).state.inbox.events[0].bodyDigest,
    createHash('sha256').update(intake.source(mailboxUser, 'mr-source').message.body).digest('hex'));
  new PrecisionIntelligenceService({ store }).correct(mailboxUser, 'mr-source', {
    workState: 'action_required', nextActor: 'me', note: 'Explicit fixture correction to work A',
  });
  const countBeforeDeny = calls.length;
  await assert.rejects(intake.mapInCrm(mailboxUser, 'mr-source', { workspaceId, workItemId: 'work-a', expectedVersion: receive.runtimeVersion }),
    { code: 'CWOS_HUMAN_HANDOFF_REQUIRED' });
  await assert.rejects(intake.receiveInCrm(mailboxUser, 'mr-source', { workspaceId: randomUUID(), expectedVersion: 0 }),
    { code: 'CWOS_WORKSPACE_NOT_BOUND' });
  assert.equal(calls.length, countBeforeDeny);
  const forged = await machineApp.inject({
    method: 'POST', url: '/api/cwos/v2/commands',
    headers: { ...machineHeaders, 'x-principal-kind': 'human', 'x-principal-id': human.principalId, 'idempotency-key': 'forged-human' },
    payload: { command: 'mail.mapWork', expectedVersion: receive.runtimeVersion, payload: {} },
  });
  assert.equal(forged.statusCode, 403);
  workSystem.commandClient = humanClient;
  const mappedA = await intake.mapInCrm(mailboxUser, 'mr-source', { workspaceId, workItemId: 'work-a', expectedVersion: receive.runtimeVersion });
  new PrecisionIntelligenceService({ store }).correct(mailboxUser, 'mr-source', {
    workState: 'action_required', nextActor: 'me', note: 'Explicit fixture correction to work B',
  });
  const mappedB = await intake.mapInCrm(mailboxUser, 'mr-source', { workspaceId, workItemId: 'work-b', expectedVersion: mappedA.runtimeVersion });
  const mappingReplay = await intake.mapInCrm(mailboxUser, 'mr-source', { workspaceId, workItemId: 'work-b', expectedVersion: 0 });
  assert.deepEqual(mappingReplay, mappedB);
  const manager = new CustomerWorkOsV2RuntimeManager(new PgCwosV2StateStore(scoped), clock);
  const reopened = await manager.readAuthorized({ ...machine, stepUpVerified: false });
  assert.equal(reopened.state.inbox.mailWorkLinks.length, 2);
  assert.equal(reopened.state.inbox.mailWorkLinks.find(link => link.workItemId === 'work-a').linkStatus, 'CORRECTED');
  assert.equal(reopened.state.inbox.mailWorkLinks.find(link => link.workItemId === 'work-b').linkStatus, 'ACTIVE');
  assert.equal(mailSourceDigest(intake.source(mailboxUser, 'mr-source').source), mailSourceDigest(original));
  const audit = (await db.query('SELECT command,principal_id,request_hash,after_state_hash,idempotency_key FROM cwos_v2_audit_events WHERE workspace_id=$1 ORDER BY sequence', [workspaceId])).rows;
  assert.equal(audit.filter(row => row.command === 'mail.inbox.receive').length, 1);
  assert.equal(audit.filter(row => row.command === 'mail.mapWork').length, 2);
  assert.equal(audit.at(-1).after_state_hash, reopened.stateHash);
  assert.equal(audit.at(-1).principal_id, human.principalId);
  store.close();
  store = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), now: clock });
  const reread = new MailWorkIntakeService({ store, workSystem: new CwosWorkSystemAdapter({ db: store.db }) });
  assert.equal(mailSourceDigest(reread.source(mailboxUser, 'mr-source').source), mailSourceDigest(original));
  assert.equal(reread.get(mailboxUser, 'mr-source').correction.note, 'Explicit fixture correction to work B');
  console.log(JSON.stringify({
    level: 'EXPLICIT_FIXTURE_ONLY', sourcePins: receipt.source.files,
    authority: { machine: machine.kind, mapping: human.kind, borrowedHuman: false },
    source: original, sourceDigest: mailSourceDigest(original), receive, mapping: mappedB,
    nativeInboxReceipts: 1, retainedMappings: 2, businessAuditRows: 3,
    replay: 'unchanged', lostResponseReplay: 'unchanged', denials: 3, restart: 'unchanged',
    audit: audit.slice(-3), httpCalls: calls.length, productRecordWrites: 'NATIVE_HTTP_COMMANDS_ONLY',
  }, null, 2));
} finally {
  for (const app of apps) await app.close();
  store?.close();
  await db?.end();
  if (created) await admin.query(`DROP DATABASE ${database}`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
  await assert.rejects(access(directory), { code: 'ENOENT' });
  console.log('MAIL_FP5_MR_LOCAL_CLEANUP_OK');
}
