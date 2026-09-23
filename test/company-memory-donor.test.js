import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';
import {
  MAIL_COMPANY_MEMORY_ADAPTER_STATUS,
  canonicalCompanyMemoryBytes,
  createMailProductDonorPort,
  enqueueMailCompanyMemoryOutbox,
  publishCompanyMemoryDonor,
} from '../src/application/company-memory-donor.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const WORKSPACE = '12345678-1234-4234-8234-123456789abc';
const OTHER_WORKSPACE = '22345678-1234-4234-8234-123456789abc';
const NOW = new Date('2026-09-23T10:00:00.000Z');
const AUTHORITY_DOMAIN = Buffer.from('second-brain/company-memory-authority/v1\0');
const REQUEST_DOMAIN = Buffer.from('second-brain/company-memory-request/v1\0');
const DONOR_SOURCE = fileURLToPath(new URL('../src/application/company-memory-donor.js', import.meta.url));
const MIGRATION = readFileSync(new URL('../migrations/013_mail_company_memory_outbox.sql', import.meta.url), 'utf8');

const CONTEXT = {
  providerInstanceId: 'provider:mail',
  workspaceId: WORKSPACE,
  principalId: 'principal:mail-donor',
  agentId: 'agent:mail-donor',
  sessionId: 'session:mail-donor',
  projects: ['project:company'],
  policyRevision: 'policy:1',
  deletionSequence: 2,
  deletionSetRoot: `sha256:${'a'.repeat(64)}`,
};

const SOURCE = {
  workspaceId: WORKSPACE,
  provider: 'outlook',
  mailbox: 'owner@example.test',
  sourceLocator: 'graph/msg-1',
  sourceEventId: 'event-1',
  content: 'synthetic mail evidence',
  parserVersion: 'mail:company-memory:1',
  locator: { kind: 'mail_message', ordinal: 1 },
};

function createSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    signer: {
      keyId: 'mail-donor-key:1',
      sign(message) {
        return sign(null, message, privateKey);
      },
    },
  };
}

function capturingTransport(options = {}) {
  const requests = [];
  const rememberCalls = [];
  return {
    requests,
    rememberCalls,
    remember(input) {
      rememberCalls.push(input);
    },
    async invoke(canonicalRequest) {
      requests.push(canonicalRequest);
      if (options.stdout) {
        return { exitCode: options.exitCode ?? 0, stdout: options.stdout, stderr: new Uint8Array() };
      }
      if (options.exitCode !== undefined && options.exitCode !== 0) {
        return {
          exitCode: options.exitCode,
          stdout: new Uint8Array(),
          stderr: Buffer.from('{"error":"COMPANY_AUTHORITY_REQUIRED"}'),
        };
      }
      const envelope = JSON.parse(Buffer.from(canonicalRequest).toString('utf8'));
      const receipt = {
        receipt_id: `cmreceipt:v1:${'b'.repeat(64)}`,
        receipt_digest: `sha256:${'b'.repeat(64)}`,
        workspace_id: envelope.authority.workspace_id,
        request_digest: envelope.authority.request_digest,
        operation: envelope.authority.operation,
        candidate_id: envelope.arguments.candidate_id,
        result: { state: 'candidate' },
        created_at: '2026-09-23T10:00:00.000Z',
      };
      const body = { receipt: options.mutate ? options.mutate(receipt) : receipt };
      return { exitCode: 0, stdout: Buffer.from(`${JSON.stringify(body)}\n`), stderr: new Uint8Array() };
    },
  };
}

function openOutboxDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION);
  return db;
}

function seedOutbox(db, source = SOURCE, kind = 'INBOX_RECEIVED') {
  return enqueueMailCompanyMemoryOutbox(db, {
    workspaceId: source.workspaceId,
    kind,
    provider: source.provider,
    mailbox: source.mailbox,
    sourceLocator: source.sourceLocator,
    sourceEventId: source.sourceEventId,
    workItemId: kind === 'INBOX_RECEIVED' ? null : 'work-1',
    linkId: kind === 'INBOX_RECEIVED' ? null : 'link-1',
  }, NOW.toISOString());
}

test('CWOS adapter stays fail-closed for CRM donor calls', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY); INSERT INTO messages VALUES(2);');
  db.exec(readFileSync(new URL('../migrations/012_mail_work_links.sql', import.meta.url), 'utf8'));
  const adapter = new CwosWorkSystemAdapter({ db, now: () => '2026-09-23T00:00:00Z' });
  assert.throws(() => adapter.createMailProductDonorPort(), { code: 'MAIL_ADAPTER_NOT_IMPLEMENTED' });
  await assert.rejects(adapter.write(), { code: 'CWOS_WRITE_DISABLED' });
});

test('createMailProductDonorPort fails closed without a Mail database', () => {
  assert.equal(MAIL_COMPANY_MEMORY_ADAPTER_STATUS, 'outbox_ready');
  assert.throws(() => createMailProductDonorPort(), { code: 'MAIL_ADAPTER_NOT_IMPLEMENTED' });
});

test('Mail emits keys-only CRM-consumable outbox rows from an authenticated source', () => {
  const db = openOutboxDb();
  const row = seedOutbox(db);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.kind, 'INBOX_RECEIVED');
  assert.equal(row.workspaceId, WORKSPACE);
  assert.equal(row.provider, SOURCE.provider);
  assert.equal(row.mailbox, SOURCE.mailbox);
  assert.equal(row.sourceLocator, SOURCE.sourceLocator);
  assert.equal(row.sourceEventId, SOURCE.sourceEventId);
  assert.equal(Object.hasOwn(row, 'content'), false);
  const columns = db.prepare('PRAGMA table_info(mail_company_memory_outbox)').all().map((item) => item.name);
  assert.equal(columns.includes('content'), false);
  assert.equal(columns.includes('body'), false);
  const replay = seedOutbox(db);
  assert.equal(replay.id, row.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

test('builds a signed workspace-scoped receive request and marks outbox emitted only after matching receipt', async () => {
  const { publicKey, signer } = createSigner();
  const db = openOutboxDb();
  const seeded = seedOutbox(db);
  const transport = capturingTransport();
  const result = await publishCompanyMemoryDonor({
    context: CONTEXT,
    signer,
    transport,
    outbox: createMailProductDonorPort({ db, resolveSource: () => SOURCE }),
    now: NOW,
  });

  assert.deepEqual(result.emitted, [seeded.id]);
  assert.deepEqual(result.pending, []);
  assert.equal(transport.requests.length, 1);
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox WHERE id=?').get(seeded.id).status, 'EMITTED');

  const envelope = JSON.parse(Buffer.from(transport.requests[0]).toString('utf8'));
  assert.deepEqual(Object.keys(envelope).sort(), ['arguments', 'authority']);
  assert.equal(envelope.authority.workspace_id, WORKSPACE);
  assert.equal(envelope.authority.operation, 'receive');
  assert.equal(envelope.authority.purpose, 'company_memory_receive');
  assert.equal(envelope.arguments.source_system, 'mail');
  assert.equal(envelope.arguments.source_locator, SOURCE.sourceLocator);
  assert.equal(envelope.arguments.source_event_id, SOURCE.sourceEventId);
  assert.equal(envelope.arguments.content, SOURCE.content);
  assert.equal(
    envelope.arguments.candidate_id,
    `mail:v1:${SOURCE.workspaceId}:${SOURCE.provider}:${SOURCE.mailbox}:${SOURCE.sourceLocator}:${SOURCE.sourceEventId}`,
  );

  const unsigned = { ...envelope.authority };
  const signature = unsigned.signature;
  delete unsigned.signature;
  assert.equal(typeof signature, 'string');
  assert.equal(String(signature).includes('='), false);
  const message = Buffer.concat([AUTHORITY_DOMAIN, canonicalCompanyMemoryBytes(unsigned)]);
  assert.equal(verify(null, message, publicKey, Buffer.from(String(signature), 'base64url')), true);

  const digestBody = { arguments: envelope.arguments, operation: 'receive' };
  const expectedDigest = `sha256:${createHash('sha256')
    .update(Buffer.concat([REQUEST_DOMAIN, canonicalCompanyMemoryBytes(digestBody)]))
    .digest('hex')}`;
  assert.equal(envelope.authority.request_digest, expectedDigest);
});

test('rejects missing or wrong workspace without invoking sb-company', async () => {
  const { signer } = createSigner();
  const db = openOutboxDb();
  seedOutbox(db);

  await assert.rejects(
    () => publishCompanyMemoryDonor({
      context: { ...CONTEXT, workspaceId: 'ws-1' },
      signer,
      transport: capturingTransport(),
      outbox: createMailProductDonorPort({ db, resolveSource: () => SOURCE }),
      now: NOW,
    }),
    { code: 'COMPANY_WORKSPACE_REQUIRED' },
  );
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');

  const wrongTransport = capturingTransport();
  const wrong = await publishCompanyMemoryDonor({
    context: { ...CONTEXT, workspaceId: OTHER_WORKSPACE },
    signer,
    transport: wrongTransport,
    outbox: createMailProductDonorPort({ db, resolveSource: () => SOURCE }),
    now: NOW,
  });
  assert.deepEqual(wrongTransport.requests, []);
  assert.deepEqual(wrong.emitted, []);
  assert.equal(wrong.rejected.some((item) => item.code === 'COMPANY_WORKSPACE_MISMATCH'), true);
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');

  const missingTransport = capturingTransport();
  const missing = await publishCompanyMemoryDonor({
    context: CONTEXT,
    signer,
    transport: missingTransport,
    outbox: createMailProductDonorPort({ db, resolveSource: () => ({ ...SOURCE, workspaceId: '' }) }),
    now: NOW,
  });
  assert.deepEqual(missingTransport.requests, []);
  assert.deepEqual(missing.emitted, []);
  assert.equal(missing.rejected.some((item) => item.code === 'COMPANY_WORKSPACE_REQUIRED'), true);
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');
});

test('does not write personal memory', async () => {
  const source = await readFile(DONOR_SOURCE, 'utf8');
  assert.equal(/sb remember|\/api\/remember|sb_remember|sb_search|personal vault/i.test(source), false);

  const { signer } = createSigner();
  const db = openOutboxDb();
  seedOutbox(db);
  const transport = capturingTransport();
  await publishCompanyMemoryDonor({
    context: CONTEXT,
    signer,
    transport,
    outbox: createMailProductDonorPort({ db, resolveSource: () => SOURCE }),
    now: NOW,
  });
  assert.deepEqual(transport.rememberCalls, []);
  assert.equal(transport.requests.length, 1);
});

test('is idempotent on the Mail outbox and leaves rows pending without a matching receipt', async () => {
  const { signer } = createSigner();
  const db = openOutboxDb();
  const seeded = seedOutbox(db);
  const transport = capturingTransport();
  const outbox = createMailProductDonorPort({ db, resolveSource: () => SOURCE });
  const input = { context: CONTEXT, signer, transport, outbox, now: NOW };

  const first = await publishCompanyMemoryDonor(input);
  const second = await publishCompanyMemoryDonor(input);
  assert.deepEqual(first.emitted, [seeded.id]);
  assert.deepEqual(second.emitted, []);
  assert.equal(second.attempted, 0);
  assert.equal(transport.requests.length, 1);
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'EMITTED');

  const pendingDb = openOutboxDb();
  const pendingRow = seedOutbox(pendingDb);
  const denied = await publishCompanyMemoryDonor({
    context: CONTEXT,
    signer,
    transport: capturingTransport({ exitCode: 2 }),
    outbox: createMailProductDonorPort({ db: pendingDb, resolveSource: () => SOURCE }),
    now: NOW,
  });
  assert.deepEqual(denied.emitted, []);
  assert.deepEqual(denied.pending, [pendingRow.id]);
  assert.equal(pendingDb.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');

  const mismatchDb = openOutboxDb();
  seedOutbox(mismatchDb);
  const mismatch = await publishCompanyMemoryDonor({
    context: CONTEXT,
    signer,
    transport: capturingTransport({
      mutate: (receipt) => ({ ...receipt, workspace_id: OTHER_WORKSPACE }),
    }),
    outbox: createMailProductDonorPort({ db: mismatchDb, resolveSource: () => SOURCE }),
    now: NOW,
  });
  assert.deepEqual(mismatch.emitted, []);
  assert.equal(mismatchDb.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');
});

test('SQLiteMailStore applies the company-memory outbox migration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-company-memory-'));
  const databasePath = join(directory, 'mail-intelligence.sqlite');
  let store;
  try {
    store = new SQLiteMailStore({
      databasePath,
      migrationsDir: resolve('migrations'),
    });
    const version = Number(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version);
    assert.equal(version >= 13, true);
    const table = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_company_memory_outbox'").get();
    assert.equal(table.name, 'mail_company_memory_outbox');
  } finally {
    store?.close?.();
    await rm(directory, { recursive: true, force: true });
  }
});
