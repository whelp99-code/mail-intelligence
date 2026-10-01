import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import {
  ALREADY_REPLIED_REASON,
  buildReplyDraftPlan,
  cancelAnsweredDrafts,
  hasLaterSentReply,
  needsUnansweredReply,
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
    CREATE TABLE mail_folders(id INTEGER PRIMARY KEY, well_known_name TEXT, display_name TEXT NOT NULL DEFAULT '');
    INSERT INTO mail_folders(id, well_known_name, display_name) VALUES
      (1, 'inbox', '받은 편지함'), (2, 'sentitems', 'Sent Items'), (6, 'inbox', '받은 편지함'),
      (8, 'sentitems', '보낸 편지함'), (20, '', '');
    CREATE TABLE messages(
      id INTEGER PRIMARY KEY, mailbox_id INTEGER, folder_id INTEGER, deleted_at TEXT,
      subject TEXT, normalized_subject TEXT NOT NULL DEFAULT '', sender_email TEXT, sender_name TEXT,
      body_preview TEXT, body_text TEXT, is_draft INTEGER, is_promotional INTEGER,
      received_at TEXT, sent_at TEXT, first_seen_at TEXT, graph_id TEXT,
      conversation_id TEXT NOT NULL DEFAULT '', internet_message_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE message_recipients(
      message_id INTEGER, recipient_type TEXT, email_norm TEXT, email TEXT
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
  assert.equal(row.status, 'needs_clarification');
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

function insertSent(db, row) {
  db.prepare(`
    INSERT INTO messages(id,mailbox_id,folder_id,subject,normalized_subject,sender_email,body_preview,body_text,is_draft,is_promotional,received_at,sent_at,first_seen_at,graph_id,conversation_id)
    VALUES (@id,1,@folder,@subject,@normalized,'me@whelp.example',@body,@body,0,0,@received,@sent,@received,@graph,@conversation)
  `).run({
    id: row.id,
    folder: row.folder,
    subject: row.subject,
    normalized: row.normalized,
    body: row.body || '회신',
    received: row.sent,
    sent: row.sent,
    graph: `g-${row.id}`,
    conversation: row.conversation || '',
  });
  for (const email of row.to || []) {
    db.prepare('INSERT INTO message_recipients(message_id, recipient_type, email_norm, email) VALUES (?, \'to\', ?, ?)')
      .run(row.id, email.toLowerCase(), email);
  }
}

test('reply gap is only inbound action or decision mail with no later sent reply', () => {
  const inbound = {
    id: 1,
    conversation_id: 'conv-1',
    subject: '견적 요청',
    normalized_subject: '견적 요청',
    sender_email: 'buyer@vendor.example',
    received_at: '2026-10-01T01:00:00.000Z',
    classification: { workState: 'action_required' },
    well_known_name: 'inbox',
  };
  const earlier = {
    folder_id: 8,
    well_known_name: 'sentitems',
    conversation_id: 'conv-1',
    sent_at: '2026-09-30T01:00:00.000Z',
    subject: 'Re: 견적 요청',
  };
  const later = { ...earlier, sent_at: '2026-10-01T02:00:00.000Z' };
  assert.equal(needsUnansweredReply(inbound, [earlier]), true);
  assert.equal(needsUnansweredReply(inbound, [later]), false);
  assert.equal(needsUnansweredReply({ ...inbound, classification: { workState: 'reference' } }, []), false);
  assert.equal(needsUnansweredReply({ ...inbound, classification: { workState: 'decision_required' } }, []), true);
  assert.equal(hasLaterSentReply(inbound, [{ ...later, well_known_name: 'inbox', folder_id: 6 }]), false);
});

test('reply gap falls back to normalized Re subject and recipient domain', () => {
  const inbound = {
    conversation_id: '',
    subject: '납기 확인',
    normalized_subject: '납기 확인',
    sender_email: 'lee@partner.example',
    received_at: '2026-10-01T03:00:00.000Z',
    classification: { workState: 'decision_required' },
    well_known_name: 'inbox',
  };
  const sent = {
    folder_id: 8,
    display_name: '보낸 편지함',
    conversation_id: 'other',
    subject: 'Re: 납기 확인',
    normalized_subject: '납기 확인',
    sent_at: '2026-10-01T04:00:00.000Z',
    to: ['lee@partner.example'],
  };
  assert.equal(needsUnansweredReply(inbound, [sent]), false);
  assert.equal(needsUnansweredReply(inbound, [{ ...sent, to: ['other@elsewhere.example'] }]), true);
});

test('pipeline skips a draft when a later folder-8 reply exists and still drafts if the sent mail is earlier', () => {
  const db = fixtureDb();
  insert(db, {
    id: 11,
    subject: '견적 요청',
    email: 'buyer@example.com',
    body: '견적 요청드립니다. 회신 부탁드립니다.',
    workState: 'action_required',
  });
  db.prepare('UPDATE messages SET conversation_id = \'conv-later\', received_at = \'2026-10-01T01:00:00.000Z\', normalized_subject = \'견적 요청\' WHERE id = 11').run();
  insertSent(db, {
    id: 12,
    folder: 8,
    subject: 'Re: 견적 요청',
    normalized: '견적 요청',
    sent: '2026-10-01T05:00:00.000Z',
    conversation: 'conv-later',
    to: ['buyer@example.com'],
  });
  insert(db, {
    id: 13,
    subject: '계약 확인 부탁',
    email: 'lee@example.com',
    body: '계약서 확인 부탁드립니다.',
    workState: 'action_required',
  });
  db.prepare('UPDATE messages SET conversation_id = \'conv-early\', received_at = \'2026-10-01T06:00:00.000Z\' WHERE id = 13').run();
  insertSent(db, {
    id: 14,
    folder: 8,
    subject: 'Re: 계약 확인 부탁',
    normalized: '계약 확인 부탁',
    sent: '2026-10-01T01:00:00.000Z',
    conversation: 'conv-early',
  });
  const drafts = new MailSendDrafts(db, { now: () => '2026-10-01T07:00:00.000Z' });
  const summary = runReplyDraftPipeline({ db, drafts, dryRun: false, now: '2026-10-01T07:00:00.000Z' });
  assert.equal(summary.bySkip.already_replied, 1);
  assert.equal(summary.drafted, 1);
  assert.equal(db.prepare('SELECT message_id FROM mail_send_drafts').get().message_id, 13);
  db.close();
});

test('sync cancel path cancels only pending needs_approval drafts when a later sent reply arrives', () => {
  const db = fixtureDb();
  insert(db, {
    id: 21,
    subject: '견적 요청',
    email: 'buyer@example.com',
    body: '견적 요청드립니다. 회신 부탁드립니다.',
    workState: 'action_required',
  });
  db.prepare('UPDATE messages SET conversation_id = \'conv-cancel\', received_at = \'2026-10-01T01:00:00.000Z\', normalized_subject = \'견적 요청\' WHERE id = 21').run();
  insert(db, {
    id: 22,
    subject: '발주 확정',
    email: 'choi@example.com',
    body: '발주 확정 부탁드립니다.',
    workState: 'decision_required',
  });
  db.prepare('UPDATE messages SET conversation_id = \'conv-approved\', received_at = \'2026-10-01T01:00:00.000Z\' WHERE id = 22').run();
  const drafts = new MailSendDrafts(db, { now: () => '2026-10-01T02:00:00.000Z' });
  const pending = drafts.create(1, 'jarvis', {
    request_id: 'reply.m21',
    to: ['buyer@example.com'],
    subject: 'RE: 견적 요청',
    body_text: '확인하겠습니다.',
    message_id: 21,
  });
  const approved = drafts.create(1, 'jarvis', {
    request_id: 'reply.m22',
    to: ['choi@example.com'],
    subject: 'RE: 발주 확정',
    body_text: '확인하겠습니다.',
    message_id: 22,
  });
  drafts.approve(1, approved.draft.draft_id, {
    actor: 'session:owner',
    digest: approved.draft.payload_digest,
    allowSend: true,
    hasSendScope: true,
  });
  insertSent(db, {
    id: 23,
    folder: 8,
    subject: 'Re: 견적 요청',
    normalized: '견적 요청',
    sent: '2026-10-01T03:00:00.000Z',
    conversation: 'conv-cancel',
    to: ['buyer@example.com'],
  });
  insertSent(db, {
    id: 24,
    folder: 8,
    subject: 'Re: 발주 확정',
    normalized: '발주 확정',
    sent: '2026-10-01T03:00:00.000Z',
    conversation: 'conv-approved',
    to: ['choi@example.com'],
  });
  const result = cancelAnsweredDrafts({ db, drafts, mailboxId: 1 });
  assert.equal(result.cancelled, 1);
  assert.equal(result.reason, ALREADY_REPLIED_REASON);
  assert.equal(db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id = ?').get(pending.draft.draft_id).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id = ?').get(approved.draft.draft_id).status, 'approved');
  const audit = db.prepare('SELECT actor, reason, status FROM mail_send_draft_events WHERE draft_id = ? AND status = \'cancelled\'').get(pending.draft.draft_id);
  assert.equal(audit.reason, '이미 회신함');
  assert.equal(audit.actor, 'system:already-replied');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mail_send_draft_events WHERE draft_id = ? AND status = \'cancelled\'').get(approved.draft.draft_id).c, 0);
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

test('folder copies of one mail produce one reply draft; distinct mails stay separate', () => {
  const db = fixtureDb();
  const body = '견적 요청드립니다. 회신 부탁드립니다.';
  const seen = '2026-10-01T01:01:00.000Z';
  const insertCopy = (row) => {
    db.prepare(`
      INSERT INTO messages(id,mailbox_id,folder_id,subject,normalized_subject,sender_email,sender_name,body_preview,body_text,is_draft,is_promotional,received_at,first_seen_at,graph_id,internet_message_id)
      VALUES (@id,1,@folder,@subject,@normalized,@email,'Fixture',@body,@body,0,0,@received,@received,@graph,@imid)
    `).run(row);
    db.prepare('INSERT INTO precision_classifications(message_id, work_state, source) VALUES (?, ?, ?)').run(row.id, 'action_required', 'stored');
  };
  insertCopy({ id: 755, folder: 6, subject: 'Re: 견적 요청', normalized: '견적 요청', email: 'buyer@example.com', body, received: seen, graph: 'g-755', imid: '<same-mail@example.com>' });
  insertCopy({ id: 760, folder: 20, subject: '견적 요청', normalized: '견적 요청', email: 'buyer@example.com', body, received: seen, graph: 'g-760', imid: '<same-mail@example.com>' });
  insertCopy({ id: 801, folder: 6, subject: '계약 확인 부탁', normalized: '계약 확인 부탁', email: 'lee@example.com', body: '계약서 확인 부탁드립니다.', received: seen, graph: 'g-801', imid: '' });
  insertCopy({ id: 802, folder: 20, subject: '계약 확인 부탁', normalized: '계약 확인 부탁', email: 'lee@example.com', body: '계약서 확인 부탁드립니다.', received: seen, graph: 'g-802', imid: '' });
  insertCopy({ id: 901, folder: 6, subject: '납기 안내', normalized: '납기 안내', email: 'park@example.com', body: '납기 일정 안내 부탁드립니다.', received: '2026-10-01T02:00:00.000Z', graph: 'g-901', imid: '<other-a@example.com>' });
  insertCopy({ id: 902, folder: 6, subject: '발주 일정', normalized: '발주 일정', email: 'choi@example.com', body: '발주일 확정 부탁드립니다.', received: '2026-10-01T03:00:00.000Z', graph: 'g-902', imid: '<other-b@example.com>' });
  const drafts = new MailSendDrafts(db, { now: () => '2026-10-01T01:02:00.000Z' });
  const queuePath = join(mkdtempSync(join(tmpdir(), 'reply-dedupe-')), 'pending.jsonl');
  const once = runReplyDraftPipeline({ db, drafts, dryRun: false, queuePath, now: '2026-10-01T01:02:00.000Z' });
  const twice = runReplyDraftPipeline({ db, drafts, dryRun: false, queuePath, now: '2026-10-01T01:02:00.000Z' });
  assert.equal(once.drafted, 4);
  assert.equal(twice.drafted, 0);
  assert.equal(twice.alreadyDrafted, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM mail_send_drafts').get().c, 4);
  const rows = db.prepare('SELECT request_id, message_id, status FROM mail_send_drafts ORDER BY message_id').all();
  assert.deepEqual(rows.map((row) => row.message_id), [755, 801, 901, 902]);
  assert.deepEqual(rows.map((row) => row.request_id), ['reply.m755', 'reply.m801', 'reply.m901', 'reply.m902']);
  assert.equal(rows.every((row) => row.status === 'needs_clarification'), true);
  db.close();
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
