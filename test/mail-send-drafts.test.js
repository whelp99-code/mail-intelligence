import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT); INSERT INTO messages VALUES(1,1,NULL),(2,2,NULL);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
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
