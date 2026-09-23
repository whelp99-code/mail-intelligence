import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  createMailProductDonorPort,
  enqueueMailCompanyMemoryOutbox,
} from '../src/application/company-memory-donor.js';
import {
  loadCompanyMemoryDonorBind,
  runBoundCompanyMemoryDonorTick,
} from '../src/application/company-memory-donor-bind.js';

const WORKSPACE = '12345678-1234-4234-8234-123456789abc';
const NOW = new Date('2026-09-23T10:00:00.000Z');
const BIND_SOURCE = fileURLToPath(new URL('../src/application/company-memory-donor-bind.js', import.meta.url));
const SERVER_SOURCE = fileURLToPath(new URL('../server.mjs', import.meta.url));
const MIGRATION = readFileSync(new URL('../migrations/013_mail_company_memory_outbox.sql', import.meta.url), 'utf8');

const AUTHORITY = {
  keyId: 'mail-donor-key:1',
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

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  fs.writeFileSync(
    path.join(dir, "invoked.json"),
    JSON.stringify({ argv: process.argv.slice(2), raw, sbConfig: process.env.SB_CONFIG || "" }),
  );
  const envelope = JSON.parse(raw);
  process.stdout.write(
    JSON.stringify({
      receipt: {
        receipt_id: "cmreceipt:v1:${'b'.repeat(64)}",
        receipt_digest: "sha256:${'b'.repeat(64)}",
        workspace_id: envelope.authority.workspace_id,
        request_digest: envelope.authority.request_digest,
        operation: envelope.authority.operation,
        candidate_id: envelope.arguments.candidate_id,
        result: { state: "candidate" },
        created_at: "2026-09-23T10:00:00.000Z",
      },
    }) + "\\n",
  );
});
`;

const PERSONAL_SB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "sb-invoked.txt"), "remember\\n");
process.exit(99);
`;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mail-donor-bind-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

function writePem(dir) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const file = join(dir, 'donor-ed25519.pem');
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return file;
}

function writeAuthority(dir) {
  const file = join(dir, 'authority.json');
  writeFileSync(file, `${JSON.stringify(AUTHORITY)}\n`);
  return file;
}

function writeConfig(dir) {
  const file = join(dir, 'sb-company-config.json');
  writeFileSync(file, `${JSON.stringify({ schema_version: 1, workspace_id: WORKSPACE })}\n`);
  return file;
}

function writeExecutable(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function completeEnv(dir) {
  const command = writeExecutable(dir, 'sb-company', STUB);
  writeExecutable(dir, 'sb', PERSONAL_SB);
  return {
    COMPANY_MEMORY_SB_COMPANY: command,
    COMPANY_MEMORY_SB_COMPANY_CONFIG: writeConfig(dir),
    COMPANY_MEMORY_SIGNING_KEY_FILE: writePem(dir),
    COMPANY_MEMORY_AUTHORITY_FILE: writeAuthority(dir),
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
  }, NOW.toISOString());
}

function pendingOutbox() {
  const seeded = {
    id: 'mail:v1:fixture',
    workspaceId: WORKSPACE,
    kind: 'INBOX_RECEIVED',
    provider: SOURCE.provider,
    mailbox: SOURCE.mailbox,
    sourceLocator: SOURCE.sourceLocator,
    sourceEventId: SOURCE.sourceEventId,
    workItemId: null,
    linkId: null,
    status: 'PENDING',
    createdAt: '2026-09-23T09:00:00.000Z',
    version: 1,
  };
  const emitted = [];
  return {
    emitted,
    listPending() {
      if (emitted.includes(seeded.id)) return [];
      return [{ event: seeded, source: SOURCE }];
    },
    markEmitted(_workspaceId, id) {
      emitted.push(id);
    },
  };
}

test('stays disabled when donor env is absent', async () => {
  assert.deepEqual(loadCompanyMemoryDonorBind({}), { enabled: false });
  const skipped = await runBoundCompanyMemoryDonorTick({});
  assert.deepEqual(skipped, { skipped: true });
});

test('fails closed when donor env is incomplete or unknown', () => {
  const dir = tempDir();
  try {
    const command = writeExecutable(dir, 'sb-company', STUB);
    assert.throws(
      () => loadCompanyMemoryDonorBind({ COMPANY_MEMORY_SB_COMPANY: command }),
      /COMPANY_MEMORY_ENV_INCOMPLETE/,
    );
    assert.equal(existsSync(join(dir, 'invoked.json')), false);

    const complete = completeEnv(dir);
    assert.throws(
      () => loadCompanyMemoryDonorBind({ ...complete, COMPANY_MEMORY_FOO: '1' }),
      /COMPANY_MEMORY_ENV_INCOMPLETE/,
    );

    assert.throws(
      () => loadCompanyMemoryDonorBind({
        ...complete,
        COMPANY_MEMORY_SIGNING_KEY_FILE: join(dir, 'missing.pem'),
      }),
      /COMPANY_MEMORY_ENV_INCOMPLETE/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects personal sb and does not invoke it', () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    env.COMPANY_MEMORY_SB_COMPANY = join(dir, 'sb');
    assert.throws(() => loadCompanyMemoryDonorBind(env), /COMPANY_MEMORY_COMMAND_INVALID/);
    assert.equal(existsSync(join(dir, 'sb-invoked.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticks the isolated sb-company command with key files and marks outbox emitted', async () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    const bind = loadCompanyMemoryDonorBind(env);
    assert.equal(bind.enabled, true);
    if (!bind.enabled) throw new Error('expected enabled bind');
    assert.equal(bind.command.endsWith('/sb-company'), true);

    const outbox = pendingOutbox();
    const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW, outbox });
    assert.equal(ran.skipped, false);
    if (ran.skipped) throw new Error('expected donor tick');
    assert.deepEqual(ran.result.emitted, ['mail:v1:fixture']);
    assert.deepEqual(ran.result.pending, []);
    assert.deepEqual(outbox.emitted, ['mail:v1:fixture']);

    const invoked = JSON.parse(readFileSync(join(dir, 'invoked.json'), 'utf8'));
    assert.deepEqual(invoked.argv, ['--config', env.COMPANY_MEMORY_SB_COMPANY_CONFIG]);
    assert.equal(invoked.sbConfig.endsWith('personal-sb-unused.toml'), true);
    const envelope = JSON.parse(invoked.raw);
    assert.deepEqual(Object.keys(envelope).sort(), ['arguments', 'authority']);
    assert.equal(envelope.arguments.source_system, 'mail');
    assert.equal(envelope.authority.workspace_id, WORKSPACE);
    assert.equal(envelope.authority.operation, 'receive');
    assert.equal(existsSync(join(dir, 'sb-invoked.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keeps an empty outbox when donor env is complete and Mail db is absent', async () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW });
    assert.equal(ran.skipped, false);
    if (ran.skipped) throw new Error('expected donor tick');
    assert.deepEqual(ran.result, { attempted: 0, emitted: [], pending: [], rejected: [] });
    assert.equal(existsSync(join(dir, 'invoked.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fails closed when Mail db is bound but outbox schema is unavailable', async () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    const db = new DatabaseSync(':memory:');
    await assert.rejects(
      () => runBoundCompanyMemoryDonorTick(env, { now: NOW, db }),
      /COMPANY_MEMORY_OUTBOX_UNAVAILABLE/,
    );
    assert.equal(existsSync(join(dir, 'invoked.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ticks pending Mail sqlite outbox rows when db is bound with source', async () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    const db = openOutboxDb();
    const seeded = seedOutbox(db);
    const ran = await runBoundCompanyMemoryDonorTick(env, {
      now: NOW,
      db,
      outbox: createMailProductDonorPort({ db, resolveSource: () => SOURCE }),
    });
    assert.equal(ran.skipped, false);
    if (ran.skipped) throw new Error('expected donor tick');
    assert.equal(ran.result.attempted, 1);
    assert.deepEqual(ran.result.emitted, [seeded.id]);
    assert.deepEqual(ran.result.pending, []);
    assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox WHERE id=?').get(seeded.id).status, 'EMITTED');

    const invoked = JSON.parse(readFileSync(join(dir, 'invoked.json'), 'utf8'));
    const envelope = JSON.parse(invoked.raw);
    assert.equal(envelope.arguments.source_system, 'mail');
    assert.equal(envelope.arguments.source_event_id, SOURCE.sourceEventId);
    assert.equal(envelope.authority.workspace_id, WORKSPACE);
    assert.equal(existsSync(join(dir, 'sb-invoked.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves authenticated Mail source from sqlite and does not invoke without it', async () => {
  const dir = tempDir();
  try {
    const env = completeEnv(dir);
    const pendingDb = openOutboxDb();
    const pendingRow = seedOutbox(pendingDb);
    const pending = await runBoundCompanyMemoryDonorTick(env, { now: NOW, db: pendingDb });
    assert.equal(pending.skipped, false);
    if (pending.skipped) throw new Error('expected donor tick');
    assert.deepEqual(pending.result.emitted, []);
    assert.deepEqual(pending.result.pending, [pendingRow.id]);
    assert.equal(pendingDb.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'PENDING');
    assert.equal(existsSync(join(dir, 'invoked.json')), false);

    const db = openOutboxDb();
    db.exec(`
      CREATE TABLE mailboxes (
        id INTEGER PRIMARY KEY,
        mailbox_key TEXT NOT NULL,
        address TEXT NOT NULL DEFAULT '',
        graph_user TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        mailbox_id INTEGER NOT NULL,
        graph_id TEXT NOT NULL,
        internet_message_id TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        body_preview TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        deleted_at TEXT
      );
    `);
    db.prepare('INSERT INTO mailboxes(id, mailbox_key, address, graph_user) VALUES (1, ?, ?, ?)')
      .run(SOURCE.mailbox, SOURCE.mailbox, SOURCE.mailbox);
    db.prepare('INSERT INTO messages(id, mailbox_id, graph_id, internet_message_id, subject, body_preview, body_text) VALUES (1, 1, ?, ?, ?, ?, ?)')
      .run(SOURCE.sourceLocator, SOURCE.sourceEventId, 'synthetic', '', SOURCE.content);
    const seeded = seedOutbox(db);
    const ran = await runBoundCompanyMemoryDonorTick(env, { now: NOW, db });
    assert.equal(ran.skipped, false);
    if (ran.skipped) throw new Error('expected donor tick');
    assert.deepEqual(ran.result.emitted, [seeded.id]);
    assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'EMITTED');
    const invoked = JSON.parse(readFileSync(join(dir, 'invoked.json'), 'utf8'));
    const envelope = JSON.parse(invoked.raw);
    assert.equal(envelope.arguments.source_system, 'mail');
    assert.equal(envelope.arguments.content, SOURCE.content);
    assert.equal(envelope.arguments.candidate_id, `mail:v1:${SOURCE.workspaceId}:${SOURCE.provider}:${SOURCE.mailbox}:${SOURCE.sourceLocator}:${SOURCE.sourceEventId}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not bind personal memory APIs and is wired into server.mjs', () => {
  const bindSource = readFileSync(BIND_SOURCE, 'utf8');
  const serverSource = readFileSync(SERVER_SOURCE, 'utf8');
  assert.equal(/sb remember|\/api\/remember|sb_remember|sb_search|personal vault/i.test(bindSource), false);
  assert.equal(/sb remember|\/api\/remember|sb_remember|sb_search/i.test(serverSource), false);
  assert.equal(serverSource.includes('loadCompanyMemoryDonorBind'), true);
  assert.equal(serverSource.includes('runBoundCompanyMemoryDonorTick'), true);
  assert.equal(serverSource.includes('company-memory-donor-bind.js'), true);
});
