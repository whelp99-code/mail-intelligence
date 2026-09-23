import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import {
  enqueueSentDraftCompanyMemoryOutbox,
} from '../src/application/company-memory-donor.js';
import {
  resolveMailCompanyMemorySource,
  runBoundCompanyMemoryDonorTick,
} from '../src/application/company-memory-donor-bind.js';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSPACE = '12345678-1234-4234-8234-123456789abc';
const DRAFT_ID = '98e52d8a-6f49-496f-b375-661330c245c5';
const NOW = '2026-09-23T01:01:40.000Z';
const OUTBOX = readFileSync(new URL('../migrations/013_mail_company_memory_outbox.sql', import.meta.url), 'utf8');
const DRAFTS = readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8');
const PRINCIPALS = readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8');

const input = {
  request_id: 'k04-whelp99-20260923',
  to: ['owner@example.test'],
  subject: 'Fixture subject',
  body_text: 'Synthetic fixture only.',
};
const approval = (draft) => ({
  actor: 'session:owner',
  digest: draft.payload_digest,
  allowSend: true,
  hasSendScope: true,
});

function openDb({ outbox = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mailboxes (
      id INTEGER PRIMARY KEY,
      mailbox_key TEXT NOT NULL DEFAULT 'me',
      address TEXT NOT NULL DEFAULT 'me',
      graph_user TEXT NOT NULL DEFAULT 'me'
    );
    INSERT INTO mailboxes(id, mailbox_key, address, graph_user) VALUES (1, 'me', 'me', 'me');
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      mailbox_id INTEGER,
      deleted_at TEXT,
      graph_id TEXT,
      internet_message_id TEXT,
      body_text TEXT,
      body_preview TEXT
    );
  `);
  db.exec(DRAFTS);
  db.exec(PRINCIPALS);
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  if (outbox) db.exec(OUTBOX);
  return db;
}

function sentDraft(service) {
  const { draft } = service.create(1, 'grok-bot', input);
  service.approve(1, draft.draft_id, approval(draft));
  assert.equal(service.claim(1, draft.draft_id), true);
  return service.recordOutcome(1, draft.draft_id, {
    graphMessageId: 'graph-fixture-k04',
    sentAt: '2026-09-23T01:01:40Z',
  });
}

test('sent draft does not enqueue without a company-memory workspace', (t) => {
  const db = openDb();
  t.after(() => db.close());
  const service = new MailSendDrafts(db, { now: () => NOW });
  const sent = sentDraft(service);
  assert.equal(sent.status, 'sent');
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
});

test('enqueue of a sent draft is keyed by draft_id and is idempotent', (t) => {
  const db = openDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO mail_send_drafts
      (draft_id,mailbox_id,request_id,source,owner_principal,message_id,to_json,cc_json,subject,body_text,payload_digest,status,created_at,approved_at,approved_by,sent_at,graph_message_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    DRAFT_ID, 1, 'k04-backfill', 'grok-bot', 'agent:grok-bot', null,
    '["owner@example.test"]', '[]', 'Fixture subject', 'Synthetic fixture only.',
    'digest', 'sent', NOW, NOW, 'session:owner', '2026-09-23T01:01:40Z', 'graph-fixture-k04',
  );
  const first = enqueueSentDraftCompanyMemoryOutbox(db, {
    workspaceId: WORKSPACE,
    draftId: DRAFT_ID,
    provider: 'outlook',
  }, NOW);
  const second = enqueueSentDraftCompanyMemoryOutbox(db, {
    workspaceId: WORKSPACE,
    draftId: DRAFT_ID,
    provider: 'outlook',
  }, NOW);
  assert.equal(first.status, 'PENDING');
  assert.equal(first.kind, 'INBOX_RECEIVED');
  assert.equal(first.sourceEventId, DRAFT_ID);
  assert.equal(first.sourceLocator, `mail-send-draft:${DRAFT_ID}`);
  assert.equal(first.mailbox, 'me');
  assert.equal(first.provider, 'outlook');
  assert.equal(Object.hasOwn(first, 'content'), false);
  assert.equal(Object.hasOwn(first, 'body'), false);
  assert.equal(second.id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

test('enqueue fails closed unless the draft is sent and outbox schema exists', (t) => {
  const db = openDb();
  t.after(() => db.close());
  const service = new MailSendDrafts(db, { now: () => NOW });
  const pending = service.create(1, 'grok-bot', input).draft;
  assert.throws(
    () => enqueueSentDraftCompanyMemoryOutbox(db, { workspaceId: WORKSPACE, draftId: pending.draft_id }, NOW),
    { code: 'DRAFT_NOT_SENT' },
  );
  assert.throws(
    () => enqueueSentDraftCompanyMemoryOutbox(db, { workspaceId: WORKSPACE, draftId: '00000000-0000-4000-8000-000000000000' }, NOW),
    { code: 'DRAFT_NOT_FOUND' },
  );
  const bare = new DatabaseSync(':memory:');
  t.after(() => bare.close());
  assert.throws(
    () => enqueueSentDraftCompanyMemoryOutbox(bare, { workspaceId: WORKSPACE, draftId: DRAFT_ID }, NOW),
    { code: 'COMPANY_MEMORY_OUTBOX_UNAVAILABLE' },
  );
});

test('recordOutcome sent enqueues one outbox row when company-memory is bound', (t) => {
  const db = openDb();
  t.after(() => db.close());
  const service = new MailSendDrafts(db, {
    now: () => NOW,
    companyMemory: { workspaceId: WORKSPACE, provider: 'outlook' },
  });
  const sent = sentDraft(service);
  assert.equal(sent.status, 'sent');
  const row = db.prepare('SELECT * FROM mail_company_memory_outbox').get();
  assert.equal(row.kind, 'INBOX_RECEIVED');
  assert.equal(row.source_event_id, sent.draft_id);
  assert.equal(row.source_locator, `mail-send-draft:${sent.draft_id}`);
  assert.equal(row.status, 'PENDING');
  assert.equal(row.workspace_id, WORKSPACE);
  service.recordOutcome(1, sent.draft_id, { graphMessageId: 'graph-fixture-k04', sentAt: '2026-09-23T01:01:40Z' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

test('bound send fails closed when outbox schema is missing', (t) => {
  const db = openDb({ outbox: false });
  t.after(() => db.close());
  const service = new MailSendDrafts(db, {
    now: () => NOW,
    companyMemory: { workspaceId: WORKSPACE, provider: 'outlook' },
  });
  const { draft } = service.create(1, 'grok-bot', input);
  service.approve(1, draft.draft_id, approval(draft));
  assert.equal(service.claim(1, draft.draft_id), true);
  assert.throws(
    () => service.recordOutcome(1, draft.draft_id, { graphMessageId: 'graph-fixture-k04', sentAt: '2026-09-23T01:01:40Z' }),
    { code: 'COMPANY_MEMORY_OUTBOX_UNAVAILABLE' },
  );
  assert.equal(service.get(1, draft.draft_id).status, 'sending');
});

test('resolves a sent-draft source without scanning messages or copying bodies', (t) => {
  const db = openDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO mail_send_drafts
      (draft_id,mailbox_id,request_id,source,owner_principal,message_id,to_json,cc_json,subject,body_text,payload_digest,status,created_at,approved_at,approved_by,sent_at,graph_message_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    DRAFT_ID, 1, 'k04-backfill', 'grok-bot', 'agent:grok-bot', null,
    '["owner@example.test"]', '[]', 'Fixture subject', 'DO-NOT-COPY-BODY',
    'digest', 'sent', NOW, NOW, 'session:owner', '2026-09-23T01:01:40Z', 'graph-fixture-k04',
  );
  const event = enqueueSentDraftCompanyMemoryOutbox(db, {
    workspaceId: WORKSPACE,
    draftId: DRAFT_ID,
  }, NOW);
  const source = resolveMailCompanyMemorySource(db, event);
  assert.equal(source.workspaceId, WORKSPACE);
  assert.equal(source.sourceEventId, DRAFT_ID);
  assert.equal(source.sourceLocator, `mail-send-draft:${DRAFT_ID}`);
  assert.equal(source.content.includes('DO-NOT-COPY-BODY'), false);
  assert.equal(source.content.includes(DRAFT_ID), true);
  assert.equal(source.locator.kind, 'mail_send_draft');
  assert.equal(source.locator.draft_id, DRAFT_ID);
  assert.equal(source.locator.graph_id, 'graph-fixture-k04');
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf8");
  fs.writeFileSync(path.join(dir, "invoked.json"), JSON.stringify({ raw }));
  const envelope = JSON.parse(raw);
  process.stdout.write(JSON.stringify({
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
  }) + "\\n");
});
`;

test('donor tick emits a sent-draft outbox row without inbox ingest', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-sent-outbox-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const command = join(dir, 'sb-company');
  writeFileSync(command, STUB, { mode: 0o755 });
  chmodSync(command, 0o755);
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKeyFile = join(dir, 'donor-ed25519.pem');
  writeFileSync(signingKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const authorityFile = join(dir, 'authority.json');
  writeFileSync(authorityFile, `${JSON.stringify({
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
  })}\n`);
  const configPath = join(dir, 'sb-company-config.json');
  writeFileSync(configPath, `${JSON.stringify({ schema_version: 1, workspace_id: WORKSPACE })}\n`);

  const db = openDb();
  t.after(() => db.close());
  db.prepare(`
    INSERT INTO mail_send_drafts
      (draft_id,mailbox_id,request_id,source,owner_principal,message_id,to_json,cc_json,subject,body_text,payload_digest,status,created_at,approved_at,approved_by,sent_at,graph_message_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    DRAFT_ID, 1, 'k04-backfill', 'grok-bot', 'agent:grok-bot', null,
    '["owner@example.test"]', '[]', 'Fixture subject', 'Synthetic fixture only.',
    'digest', 'sent', NOW, NOW, 'session:owner', '2026-09-23T01:01:40Z', 'graph-fixture-k04',
  );
  const seeded = enqueueSentDraftCompanyMemoryOutbox(db, { workspaceId: WORKSPACE, draftId: DRAFT_ID }, NOW);
  const ran = await runBoundCompanyMemoryDonorTick({
    COMPANY_MEMORY_SB_COMPANY: command,
    COMPANY_MEMORY_SB_COMPANY_CONFIG: configPath,
    COMPANY_MEMORY_SIGNING_KEY_FILE: signingKeyFile,
    COMPANY_MEMORY_AUTHORITY_FILE: authorityFile,
  }, { now: new Date('2026-09-23T10:00:00.000Z'), db });
  assert.equal(ran.skipped, false);
  if (ran.skipped) throw new Error('expected donor tick');
  assert.deepEqual(ran.result.emitted, [seeded.id]);
  assert.equal(db.prepare('SELECT status FROM mail_company_memory_outbox').get().status, 'EMITTED');
});
