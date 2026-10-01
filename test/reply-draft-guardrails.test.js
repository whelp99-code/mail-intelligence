import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { GraphSendClient } from '../src/adapters/microsoft-graph-send.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { suggestReplyAttachments } from '../src/application/reply-attachment-suggestions.js';
import { buildReplyDraftPlan } from '../src/application/reply-draft-pipeline.js';
import { applyOwnerVoice, loadOwnerVoiceProfile } from '../src/domain/owner-voice.js';
import {
  graphTextBody,
  partnerLeak,
  replaceUngroundedNumbers,
  scrubPartnerNames,
} from '../src/domain/reply-draft-guardrails.js';

const token = `fixture.${Buffer.from(JSON.stringify({ scp: 'Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.fixture`;

test('graph text body keeps every line break from body_text', () => {
  const body = '첫 줄\n\n둘째 줄  \n  셋째';
  const graph = graphTextBody(body);
  assert.equal(graph.contentType, 'Text');
  assert.equal(graph.content, body);
  assert.equal(graph.content.split('\n').length, 4);
});

test('partner names are removed from mail to another company domain', () => {
  const body = '넥시아스 견적 번호는 내부 참고입니다. Nexias 담당.';
  const scrubbed = scrubPartnerNames(body, ['buyer@gsenc.com']);
  assert.equal(partnerLeak(scrubbed.body, ['buyer@gsenc.com']).length, 0);
  assert.match(scrubbed.body, /\{확인 필요\}/);
  assert.doesNotMatch(scrubbed.body, /넥시아스|nexias/i);
  const kept = scrubPartnerNames(body, ['vendor@nexias.co.kr']);
  assert.match(kept.body, /넥시아스/);
});

test('ungrounded numbers become a clarification placeholder', () => {
  const result = replaceUngroundedNumbers('공급가 1500000원, 수량 2', ['수량: 2']);
  assert.equal(result.ungrounded, true);
  assert.match(result.body, /\{확인 필요\}/);
  assert.match(result.body, /수량 2/);
  assert.doesNotMatch(result.body, /1500000/);
});

test('reply plan keeps voice version, blocks partner leak, and stays unsent', () => {
  const profile = loadOwnerVoiceProfile();
  const plan = buildReplyDraftPlan({
    id: 3,
    subject: '견적 요청',
    sender_email: 'buyer@gsenc.com',
    from: '홍길동 <buyer@gsenc.com>',
    body_text: '홍길동 팀장입니다. 넥시아스 경유 견적 요청드립니다. 금액 880000.',
    well_known_name: 'inbox',
  }, { workState: 'action_required', method: 'stored' }, '2026-10-01T00:00:00.000Z', {
    voiceProfile: profile,
    ownerInput: '',
  });
  assert.equal(plan.action, 'draft');
  assert.equal(plan.voiceVersion, 'owner-voice-profile-v1');
  assert.equal(plan.request.to[0], 'buyer@gsenc.com');
  assert.doesNotMatch(plan.request.body_text, /넥시아스|nexias/i);
  assert.match(plan.request.body_text, /\{확인 필요\}/);
  assert.doesNotMatch(plan.request.body_text, /880000/);
  const voiced = applyOwnerVoice('안녕하세요.\n{기본 서명}', {
    profile,
    recipients: ['lead@insunginfo.co.kr'],
  });
  assert.match(voiced.body, /jm.park@blro.co.kr/);
  assert.equal(voiced.formality, 'standard');
});

test('drafts with the placeholder cannot be approved or sent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES (1); CREATE TABLE messages(id INTEGER PRIMARY KEY, mailbox_id INTEGER, deleted_at TEXT); INSERT INTO messages VALUES (1, 1, NULL);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  const drafts = new MailSendDrafts(db, { now: () => '2026-10-01T00:00:00.000Z' });
  const created = drafts.create(1, 'jarvis', {
    request_id: 'reply.m1',
    to: ['buyer@gsenc.com'],
    subject: 'RE: 견적',
    body_text: '금액은 {확인 필요} 입니다.\n둘째 줄',
    message_id: 1,
  });
  assert.equal(created.draft.status, 'needs_clarification');
  assert.equal(created.draft.body_text, '금액은 {확인 필요} 입니다.\n둘째 줄');
  assert.throws(() => drafts.approve(1, created.draft.draft_id, {
    actor: 'session:owner', digest: created.draft.payload_digest, allowSend: true, hasSendScope: true,
  }), { code: 'DRAFT_NEEDS_CLARIFICATION' });
  db.close();
});

test('send client posts body_text line breaks unchanged and blocks partner names', async () => {
  const body = '첫째\n\n둘째  \n셋째';
  const draft = {
    draft_id: 'ea06c1bb-768c-4910-9daf-53777ec466ed',
    status: 'sending',
    approved_by: 'session:owner',
    approved_at: '2026-10-01T00:00:00Z',
    to: ['buyer@gsenc.com'],
    cc: [],
    subject: 'Fixture',
    body_text: body,
  };
  let posted = '';
  const client = new GraphSendClient({
    accessToken: token,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        posted = options.body;
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    },
  });
  await client.sendOnce(draft, { allowSend: true });
  assert.equal(JSON.parse(posted).message.body.content, body);
  await assert.rejects(client.sendOnce({ ...draft, body_text: '넥시아스 참고' }, { allowSend: true }), { code: 'PARTNER_NAME_BLOCKED' });
});

test('attachment suggestions never mark auto-attach and offer a drive link over 2MB', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE attachments(message_id INTEGER, name TEXT, size_bytes INTEGER, is_inline INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, folder_id INTEGER, sent_at TEXT);
    CREATE TABLE mail_folders(id INTEGER PRIMARY KEY, well_known_name TEXT);
    CREATE TABLE message_recipients(message_id INTEGER, recipient_type TEXT, email_norm TEXT);
    CREATE TABLE mail_attachment_assets(origin TEXT, display_name TEXT, byte_length INTEGER, drive_file_id TEXT);
    INSERT INTO attachments VALUES (9, '견적서.pdf', 100, 0);
    INSERT INTO mail_folders VALUES (2, 'sentitems');
    INSERT INTO messages VALUES (4, 2, '2026-09-01');
    INSERT INTO message_recipients VALUES (4, 'to', 'buyer@gsenc.com');
    INSERT INTO attachments VALUES (4, '견적비교.xlsx', 20, 0);
    INSERT INTO mail_attachment_assets VALUES ('drive', '견적서-원본.pdf', 3000000, 'abc123FILE');
  `);
  const suggestions = suggestReplyAttachments({
    db,
    message: { id: 9, subject: '견적서 요청' },
    recipient: 'buyer@gsenc.com',
  });
  assert.equal(suggestions.every((item) => item.autoAttach === false), true);
  assert.equal(suggestions.some((item) => item.kind === 'thread_file' && item.name === '견적서.pdf'), true);
  assert.equal(suggestions.some((item) => item.kind === 'drive_link' && item.url.includes('/file/d/abc123FILE/view')), true);
  assert.equal(suggestions.some((item) => item.kind === 'drive_link' && item.size <= 2 * 1024 * 1024), false);
  db.close();
});
