import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { SendReconciliationWorker } from '../src/application/send-reconciliation-worker.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY, graph_user TEXT); INSERT INTO mailboxes VALUES(1,\'me\'); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/010_mail_send_reconciliation.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  return db;
}

const input = { request_id: 'worker-001', to: ['test@example.com'], subject: 'Fixture', body_text: 'No real mail.' };
const approval = (draft) => ({ actor: 'session:owner', digest: draft.payload_digest, allowSend: true, hasSendScope: true });

test('worker leases sending drafts and reconciles without sending', async (t) => {
  const db = fixture(t);
  const clock = () => '2026-09-22T00:00:00.000Z';
  const drafts = new MailSendDrafts(db, { now: clock });
  const draft = drafts.create(1, 'ui', input).draft;
  drafts.approve(1, draft.draft_id, approval(draft));
  drafts.claim(1, draft.draft_id);
  let reconcileCalls = 0;
  let sendCalls = 0;
  const worker = new SendReconciliationWorker({
    db, drafts, getAccessToken: async () => 'token',
    clientFactory: () => ({
      reconcile: async () => { reconcileCalls += 1; return { graphMessageId: 'graph-id', sentAt: '2026-09-22T00:00:00Z' }; },
      sendOnce: async () => { sendCalls += 1; throw new Error('must not send'); },
    }),
    now: () => new Date('2026-09-22T00:00:00Z'),
  });
  const result = await worker.runOnce();
  assert.equal(result.claimed, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(sendCalls, 0);
  assert.equal(drafts.get(1, draft.draft_id).status, 'sent');
  assert.equal(db.prepare('SELECT state FROM mail_send_reconciliation_jobs WHERE draft_id=?').get(draft.draft_id).state, 'complete');
});

test('uncertain reconciliation remains sending and is backed off', async (t) => {
  const db = fixture(t);
  const clock = () => '2026-09-22T00:00:00.000Z';
  const drafts = new MailSendDrafts(db, { now: clock });
  const draft = drafts.create(1, 'ui', { ...input, request_id: 'worker-002' }).draft;
  drafts.approve(1, draft.draft_id, approval(draft));
  drafts.claim(1, draft.draft_id);
  const worker = new SendReconciliationWorker({
    db, drafts, getAccessToken: async () => 'token', clientFactory: () => ({ reconcile: async () => ({ uncertain: true, failureCode: 'GRAPH_RECEIPT_PENDING' }) }),
    now: () => new Date('2026-09-22T00:00:00Z'), baseBackoffMs: 1000,
  });
  const result = await worker.runOnce();
  assert.equal(result.results[0].status, 'pending');
  assert.equal(drafts.get(1, draft.draft_id).status, 'sending');
  const job = db.prepare('SELECT state,attempt_count,next_attempt_at,last_failure_code FROM mail_send_reconciliation_jobs WHERE draft_id=?').get(draft.draft_id);
  assert.equal(job.state, 'pending');
  assert.equal(job.attempt_count, 1);
  assert.equal(job.last_failure_code, 'GRAPH_RECEIPT_PENDING');
  assert.equal(job.next_attempt_at, '2026-09-22T00:00:01.000Z');
});
