import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import {
  createAttachmentAssetService,
  createSyntheticPassScanner,
} from '../src/application/mail-attachment-assets.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT); INSERT INTO messages VALUES(1,1,NULL),(2,2,NULL);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return new MailSendDrafts(db, options);
}
const input = { request_id: 'request-001', to: ['test@example.com'], subject: 'Self test', body_text: 'Synthetic fixture only.' };
const approval = (draft) => ({ actor: 'session:owner', digest: draft.payload_digest, allowSend: true, hasSendScope: true });

test('immutable draft is idempotent and payload conflicts fail closed', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'grok-bot', input);
  assert.equal(draft.status, 'needs_approval');
  assert.equal(service.create(1, 'grok-bot', input).draft.draft_id, draft.draft_id);
  assert.equal(service.create(1, 'grok-bot', input).replay, true);
  assert.throws(() => service.create(1, 'grok-bot', { ...input, body_text: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('missing recipient, subject or body requires clarification', (t) => {
  const service = fixture(t);
  for (const [index, missing] of [{ to: [] }, { subject: '' }, { body_text: '' }].entries()) {
    const { draft } = service.create(1, 'ui', { ...input, ...missing, request_id: `missing-${index}` });
    assert.equal(draft.status, 'needs_clarification');
    assert.throws(() => service.approve(1, draft.draft_id, approval(draft)), { code: 'DRAFT_NOT_APPROVABLE' });
  }
});

test('unknown fields, header injection and fabricated address syntax rejected', (t) => {
  const service = fixture(t);
  for (const bad of [{ approved: true }, { subject: 'x\r\nBcc: other@example.com' }, { to: ['김대리'] }, { to: ['a@example.com\n'] }]) {
    assert.throws(() => service.create(1, 'grok-bot', { ...input, ...bad }));
  }
});

test('configured recipient allowlist rejects disallowed to and cc at creation', (t) => {
  const service = fixture(t, { recipientAllowlist: ['allowed@example.com'] });
  assert.throws(() => service.create(1, 'ui', { ...input, to: ['blocked@example.com'] }), { code: 'RECIPIENT_NOT_ALLOWED' });
  assert.throws(() => service.create(1, 'ui', { ...input, to: ['allowed@example.com'], cc: ['blocked@example.com'] }), { code: 'RECIPIENT_NOT_ALLOWED' });
  const created = service.create(1, 'ui', { ...input, to: ['ALLOWED@example.com'] }).draft;
  assert.deepEqual(created.to, ['allowed@example.com']);
});

test('mailbox isolation and reply source ownership', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', { ...input, message_id: 1 });
  assert.throws(() => service.get(2, draft.draft_id), { code: 'DRAFT_NOT_FOUND' });
  assert.throws(() => service.create(1, 'ui', { ...input, message_id: 2 }), { code: 'SOURCE_MESSAGE_NOT_FOUND' });
});

test('approval requires explicit send flag, scope, human identity and exact digest', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', input);
  for (const [change, code] of [[{ allowSend: false }, 'MAIL_SEND_DISABLED'], [{ hasSendScope: false }, 'MAIL_SEND_SCOPE_REQUIRED'], [{ actor: 'grok-bot' }, 'HUMAN_APPROVAL_REQUIRED'], [{ digest: 'wrong' }, 'DRAFT_DIGEST_MISMATCH']]) {
    assert.throws(() => service.approve(1, draft.draft_id, { ...approval(draft), ...change }), { code });
    assert.equal(service.get(1, draft.draft_id).status, 'needs_approval');
  }
});

test('duplicate approval can claim at most once and receipt needs evidence', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', input);
  assert.equal(service.claim(1, draft.draft_id), false);
  service.approve(1, draft.draft_id, approval(draft));
  assert.equal(service.claim(1, draft.draft_id), true);
  service.approve(1, draft.draft_id, approval(draft));
  assert.equal(service.claim(1, draft.draft_id), false);
  assert.throws(() => service.recordOutcome(1, draft.draft_id, {}), { code: 'INVALID_FAILURE_CODE' });
  const sent = service.recordOutcome(1, draft.draft_id, { graphMessageId: 'graph-fixture', sentAt: '2026-09-09T00:00:00Z' });
  assert.equal(sent.status, 'sent');
  assert.equal(service.claim(1, draft.draft_id), false);
});

test('uncertain timeout remains sending and never becomes retryable', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', input);
  service.approve(1, draft.draft_id, approval(draft)); service.claim(1, draft.draft_id);
  const state = service.recordOutcome(1, draft.draft_id, { failureCode: 'GRAPH_ACCEPTANCE_UNKNOWN', uncertain: true });
  assert.equal(state.status, 'sending');
  assert.equal(state.graph_message_id, null);
  assert.equal(service.claim(1, draft.draft_id), false);
  assert.throws(() => service.cancel(1, draft.draft_id, 'session:owner'), { code: 'DRAFT_NOT_CANCELLABLE' });
});

test('cancelled and failed drafts cannot be reapproved', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', input);
  service.cancel(1, draft.draft_id, 'session:owner');
  assert.throws(() => service.approve(1, draft.draft_id, approval(draft)), { code: 'DRAFT_NOT_APPROVABLE' });
  const other = service.create(1, 'ui', { ...input, request_id: 'request-002' }).draft;
  service.approve(1, other.draft_id, approval(other)); service.claim(1, other.draft_id);
  service.recordOutcome(1, other.draft_id, { failureCode: 'GRAPH_REJECTED' });
  assert.throws(() => service.approve(1, other.draft_id, approval(other)), { code: 'DRAFT_NOT_APPROVABLE' });
});

test('jarvis drafts own a distinct principal from grok-bot and ui', (t) => {
  const service = fixture(t);
  const grok = service.create(1, 'grok-bot', input).draft;
  const jarvis = service.create(1, 'jarvis', { ...input, request_id: 'jarvis-request-001' }).draft;
  const ui = service.create(1, 'ui', { ...input, request_id: 'ui-request-001' }).draft;
  assert.equal(grok.owner_principal, 'agent:grok-bot');
  assert.equal(jarvis.owner_principal, 'agent:jarvis');
  assert.equal(ui.owner_principal, 'human:ui');
  assert.notEqual(grok.draft_id, jarvis.draft_id);
  assert.throws(() => service.create(1, 'other-agent', input), { code: 'INVALID_DRAFT_SOURCE' });
});

const V1_DIGEST = '7598f09dcc86b091cd1947e83a19b8ff86ba7a662de032638178babc14680316';
const ATTACH_KEY = Buffer.alloc(32, 13);

async function readyAsset(db, overrides = {}) {
  const assets = createAttachmentAssetService({
    db,
    getKey: async () => ATTACH_KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const bytes = overrides.bytes || Buffer.from('draft-asset-bytes', 'utf8');
  const result = await assets.upload({
    mailboxId: overrides.mailboxId ?? 1,
    source: overrides.source || 'ui',
    requestId: overrides.requestId || randomUUID(),
    displayName: overrides.displayName || 'note.txt',
    declaredMime: 'text/plain',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  return { ...result.asset, bytes };
}

test('text-only draft keeps the exact v1 canonical digest', (t) => {
  const service = fixture(t);
  const { draft } = service.create(1, 'ui', input);
  assert.equal(draft.digest_version, 1);
  assert.equal(draft.payload_digest, V1_DIGEST);
  assert.deepEqual(draft.attachments, []);
  assert.deepEqual(draft.links, []);
});

test('attachment ids bind in order and switch the draft to v2 digest', async (t) => {
  const service = fixture(t);
  const first = await readyAsset(service.db, { displayName: 'one.txt', bytes: Buffer.from('one') });
  const second = await readyAsset(service.db, { displayName: 'two.txt', bytes: Buffer.from('two') });
  const { draft } = service.create(1, 'ui', { ...input, request_id: 'request-attach-001', attachment_ids: [first.id, second.id] });
  assert.equal(draft.digest_version, 2);
  assert.equal(draft.attachments.map((item) => item.name).join(','), 'one.txt,two.txt');
  assert.equal(draft.payload_digest, createHash('sha256').update(JSON.stringify({
    version: 2,
    to: ['test@example.com'],
    cc: [],
    subject: 'Self test',
    body_text: 'Synthetic fixture only.',
    message_id: null,
    attachments: [
      {
        ordinal: 0, id: first.id, name: 'one.txt', mime: 'text/plain', size: 3,
        sha256: first.sha256, origin: 'local', drive_version: null, export_mime: null,
      },
      {
        ordinal: 1, id: second.id, name: 'two.txt', mime: 'text/plain', size: 3,
        sha256: second.sha256, origin: 'local', drive_version: null, export_mime: null,
      },
    ],
    links: [],
  })).digest('hex'));
  assert.throws(
    () => service.create(1, 'ui', { ...input, request_id: 'request-attach-001', attachment_ids: [second.id, first.id] }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('foreign, bot, unreadied, or sixth assets cannot join a draft', async (t) => {
  const service = fixture(t);
  const own = await readyAsset(service.db);
  const otherBox = await readyAsset(service.db, { mailboxId: 2 });
  const bot = await readyAsset(service.db, { source: 'grok-bot' });
  const extras = [];
  for (let index = 0; index < 5; index += 1) {
    extras.push(await readyAsset(service.db, { displayName: `n${index}.txt`, bytes: Buffer.from(String(index)) }));
  }
  assert.throws(() => service.create(1, 'ui', { ...input, request_id: randomUUID(), attachment_ids: [otherBox.id] }), { code: 'ASSET_NOT_FOUND' });
  assert.throws(() => service.create(1, 'ui', { ...input, request_id: randomUUID(), attachment_ids: [bot.id] }), { code: 'ASSET_NOT_FOUND' });
  const fiveOk = service.create(1, 'ui', { ...input, request_id: randomUUID(), attachment_ids: extras.map((item) => item.id) });
  assert.equal(fiveOk.draft.attachments.length, 5);
  assert.throws(() => service.create(1, 'ui', { ...input, request_id: randomUUID(), attachment_ids: extras.map((item) => item.id).concat(own.id) }), { statusCode: 422 });
});

test('tampered or discarded assets block approval and cannot be replaced on a stored draft', async (t) => {
  const service = fixture(t);
  const asset = await readyAsset(service.db);
  const { draft } = service.create(1, 'ui', { ...input, request_id: 'request-attach-002', attachment_ids: [asset.id] });
  service.db.prepare('UPDATE mail_attachment_assets SET sha256=? WHERE id=?').run('00'.repeat(32), asset.id);
  assert.throws(() => service.approve(1, draft.draft_id, approval(draft)), { code: 'ASSET_CHANGED' });
  service.db.prepare('UPDATE mail_attachment_assets SET sha256=?, state=? WHERE id=?').run(asset.sha256, 'expired', asset.id);
  assert.throws(() => service.approve(1, draft.draft_id, approval(draft)), { code: 'ASSET_CHANGED' });
  const replacement = await readyAsset(service.db, { displayName: 'other.txt' });
  assert.throws(
    () => service.create(1, 'ui', { ...input, request_id: 'request-attach-002', attachment_ids: [replacement.id] }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
});

test('stale scan_policy_version blocks approval without rewriting stored AAD', async (t) => {
  const service = fixture(t);
  const asset = await readyAsset(service.db);
  const { draft } = service.create(1, 'ui', { ...input, request_id: 'request-scan-policy-001', attachment_ids: [asset.id] });
  const before = service.db.prepare('SELECT encryption_aad_version, encryption_policy_version FROM mail_attachment_assets WHERE id=?').get(asset.id);
  service.db.prepare('UPDATE mail_attachment_assets SET scan_policy_version=? WHERE id=?').run('scan-policy-old', asset.id);
  assert.throws(() => service.approve(1, draft.draft_id, approval(draft)), { code: 'ASSET_CHANGED' });
  const after = service.db.prepare('SELECT encryption_aad_version, encryption_policy_version, scan_policy_version FROM mail_attachment_assets WHERE id=?').get(asset.id);
  assert.equal(after.encryption_aad_version, before.encryption_aad_version);
  assert.equal(after.encryption_policy_version, before.encryption_policy_version);
  assert.equal(after.scan_policy_version, 'scan-policy-old');
});
