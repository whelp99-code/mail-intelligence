import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import {
  buildReplyDraftPlan,
  renderMorningDigest,
  runReplyDraftPipeline,
  writeMorningDigest,
} from '../src/application/reply-draft-pipeline.js';

function fixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mailboxes(id INTEGER PRIMARY KEY);
    INSERT INTO mailboxes VALUES (1);
    CREATE TABLE mail_folders(id INTEGER PRIMARY KEY, well_known_name TEXT);
    INSERT INTO mail_folders VALUES (1, 'inbox'), (2, 'sentitems');
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY, mailbox_id INTEGER, folder_id INTEGER, deleted_at TEXT,
      subject TEXT, sender_email TEXT, sender_name TEXT, body_preview TEXT, body_text TEXT,
      is_draft INTEGER, is_promotional INTEGER, received_at TEXT, first_seen_at TEXT, graph_id TEXT
    );
    CREATE TABLE precision_classifications(message_id INTEGER PRIMARY KEY, work_state TEXT, source TEXT);
  `);
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  return db;
}

function insert(db, row) {
  db.prepare(`
    INSERT INTO messages(id,mailbox_id,folder_id,deleted_at,subject,sender_email,sender_name,body_preview,body_text,is_draft,is_promotional,received_at,first_seen_at,graph_id)
    VALUES (@id,1,@folder,NULL,@subject,@email,'Fixture',@preview,@body,0,@promo,@seen,@seen,@graph)
  `).run({
    id: row.id,
    folder: row.folder || 1,
    subject: row.subject,
    email: row.email,
    preview: row.body,
    body: row.body,
    promo: row.promo || 0,
    seen: '2026-09-29T01:00:00.000Z',
    graph: `g-${row.id}`,
  });
  if (row.workState) {
    db.prepare('INSERT INTO precision_classifications(message_id, work_state, source) VALUES (?, ?, ?)').run(row.id, row.workState, 'stored');
  }
}

test('creates one needs_approval draft and skips notifications without send', () => {
  const db = fixtureDb();
  insert(db, { id: 1, subject: '견적 요청', email: 'buyer@example.com', body: '견적 요청드립니다. 회신 부탁드립니다.', workState: 'action_required' });
  insert(db, { id: 2, subject: 'Weekly newsletter', email: 'news@vendor.com', body: 'Unsubscribe here', workState: 'action_required', promo: 1 });
  insert(db, { id: 3, subject: 'Alert', email: 'noreply@vendor.com', body: 'This is an automated notification', workState: 'action_required' });
  const drafts = new MailSendDrafts(db, { now: () => '2026-09-30T00:00:00.000Z' });
  const calls = { approve: 0, claim: 0, recordOutcome: 0 };
  drafts.approve = () => { calls.approve += 1; };
  drafts.claim = () => { calls.claim += 1; };
  drafts.recordOutcome = () => { calls.recordOutcome += 1; };
  const queuePath = join(mkdtempSync(join(tmpdir(), 'reply-draft-')), 'pending.jsonl');
  const once = runReplyDraftPipeline({ db, drafts, dryRun: false, queuePath, now: '2026-09-30T00:00:00.000Z' });
  const twice = runReplyDraftPipeline({ db, drafts, dryRun: false, queuePath, now: '2026-09-30T00:00:00.000Z' });
  assert.equal(once.drafted, 1);
  assert.equal(twice.drafted, 0);
  assert.equal(twice.alreadyDrafted, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mail_send_drafts').get().c, 1);
  const row = db.prepare('SELECT status, subject FROM mail_send_drafts').get();
  assert.equal(row.status, 'needs_approval');
  assert.match(row.subject, /^RE:/);
  const line = JSON.parse(readFileSync(queuePath, 'utf8').trim());
  assert.equal(typeof line.draftId, 'string');
  assert.equal(line.from, 'buyer@example.com');
  assert.equal(line.subject, '견적 요청');
  assert.equal(line.template, 'T1');
  assert.equal(typeof line.summary, 'string');
  assert.equal(line.summary.split('\n').length, 2);
  assert.equal(line.created_at, '2026-09-30T00:00:00.000Z');
  assert.equal(calls.approve + calls.claim + calls.recordOutcome, 0);
  db.close();
});

test('missing classification uses a labeled rules-based decision', () => {
  const plan = buildReplyDraftPlan({
    id: 9,
    subject: '자료 부탁드립니다',
    sender_email: 'lee@example.com',
    body_text: '라이선스 자료를 오늘 중으로 보내 주세요.',
    well_known_name: 'inbox',
  }, null, '2026-09-30T00:00:00.000Z');
  assert.equal(plan.action, 'draft');
  assert.equal(plan.method, 'rules-based');
  assert.equal(plan.template, 'T6');
});

test('morning digest lists category counts, pending drafts, and quote or tax mail', () => {
  const db = fixtureDb();
  insert(db, { id: 4, subject: '세금계산서 요청', email: 'tax@example.com', body: '세금계산서 발행 부탁드립니다.', workState: 'action_required' });
  insert(db, { id: 5, subject: '참고', email: 'news@example.com', body: 'newsletter unsubscribe', workState: 'reference', promo: 1 });
  const drafts = new MailSendDrafts(db, { now: () => '2026-09-29T02:00:00.000Z' });
  runReplyDraftPipeline({ db, drafts, dryRun: false, queuePath: join(mkdtempSync(join(tmpdir(), 'reply-digest-')), 'q.jsonl') });
  const out = join(mkdtempSync(join(tmpdir(), 'reply-digest-md-')), 'digest.md');
  const written = writeMorningDigest({ db, day: '2026-09-29', path: out });
  assert.match(written.markdown, /action_required: 1/);
  assert.match(written.markdown, /reference: 1/);
  assert.match(written.markdown, /count: 1/);
  assert.match(written.markdown, /tax_invoice/);
  assert.equal(readFileSync(out, 'utf8'), written.markdown);
  const rendered = renderMorningDigest({ day: '2026-09-29', countsByCategory: {}, pending: [], quoteOrTax: [] });
  assert.match(rendered, /Morning digest 2026-09-29/);
  db.close();
});
