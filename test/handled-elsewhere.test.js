import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { createHandledElsewhereApi } from '../src/application/handled-elsewhere-api.js';
import { annotateReplyGaps, needsUnansweredReply, runReplyDraftPipeline } from '../src/application/reply-draft-pipeline.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'handled-elsewhere-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: 'jm@example.com' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox-folder-id',
    wellKnownName: 'inbox',
    displayName: '받은 편지함',
  });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'initial' }),
    pageIndex: 0,
    requestUrl: 'https://graph.example/messages/delta',
    items: [normalizeGraphMessage({
      id: 'graph-lotte',
      conversationId: 'conv-lotte',
      subject: '롯데 내포',
      from: { emailAddress: { address: 'lotte@example.com', name: '롯데' } },
      toRecipients: [{ emailAddress: { address: 'jm@example.com' } }],
      receivedDateTime: '2026-10-01T01:00:00.000Z',
      bodyPreview: '회신 부탁드립니다.',
      body: { contentType: 'text', content: '회신 부탁드립니다.' },
      parentFolderId: 'inbox-folder-id',
    })],
    deltaLink: 'https://graph.example/delta',
  });
  const message = store.db.prepare('SELECT id, graph_id FROM messages WHERE graph_id = ?').get('graph-lotte');
  const now = '2026-10-01T02:00:00.000Z';
  store.db.prepare(`
    INSERT INTO precision_classifications(
      message_id, mailbox_id, work_state, next_actor, priority, fingerprint, analyzed_at, created_at, updated_at
    ) VALUES (?, ?, 'action_required', 'me', 'normal', 'fp', ?, ?, ?)
  `).run(message.id, mailbox.id, now, now, now);
  return { store, mailbox, message };
}

function apiFor(store, mailbox) {
  return createHandledElsewhereApi({
    getStore: () => store,
    getMailbox: () => ({ id: mailbox.id }),
    getSession: (req) => (req.headers.cookie === 'fixture-session'
      ? { token: 'fixture-session', csrfToken: 'fixture-csrf' }
      : null),
    readBody: async (req) => req.body || {},
    accessKeyRequired: true,
  });
}

function request({ method = 'POST', headers = {}, body = {} } = {}) {
  return {
    method,
    headers,
    body,
  };
}

const url = new URL('http://127.0.0.1:3010/api/messages/handled-elsewhere');
const human = {
  cookie: 'fixture-session',
  origin: url.origin,
  'x-csrf-token': 'fixture-csrf',
  'x-mail-intelligence-request': '1',
};

test('store persists handled_elsewhere and undo clears the active marker', async (t) => {
  const { store, mailbox, message } = await withStore(t);
  const marked = store.markHandledElsewhere(mailbox.id, message.id, {
    channel: 'kakao',
    note: '10/1 카카오',
    actor: 'session:owner',
    now: '2026-10-01T03:00:00.000Z',
  });
  assert.equal(marked.handledElsewhere.channel, 'kakao');
  assert.equal(marked.handledElsewhere.note, '10/1 카카오');
  assert.equal(marked.handledElsewhere.actor, 'session:owner');
  assert.equal(marked.handledElsewhere.markedAt, '2026-10-01T03:00:00.000Z');
  assert.equal(store.getHandledElsewhere(mailbox.id, 'graph-lotte').messageId, message.id);
  const undone = store.undoHandledElsewhere(mailbox.id, 'graph-lotte', {
    actor: 'session:owner',
    now: '2026-10-01T04:00:00.000Z',
  });
  assert.equal(undone.undone, true);
  assert.equal(store.getHandledElsewhere(mailbox.id, message.id), null);
  const row = store.db.prepare('SELECT undone_at FROM message_handled_elsewhere WHERE message_id = ?').get(message.id);
  assert.equal(row.undone_at, '2026-10-01T04:00:00.000Z');
});

test('API requires a session and CSRF and does not accept a draft bearer token', async (t) => {
  const { store, mailbox, message } = await withStore(t);
  const api = apiFor(store, mailbox);
  await assert.rejects(api(request({ headers: {} }), url), { code: 'SESSION_REQUIRED' });
  await assert.rejects(api(request({
    headers: { authorization: 'Bearer grok-token-0123456789abcdef0123456789abcdef', ...human },
  }), url), { code: 'SESSION_REQUIRED' });
  await assert.rejects(api(request({
    headers: { ...human, 'x-csrf-token': 'nope' },
    body: { messageId: message.id, channel: 'phone' },
  }), url), { code: 'CSRF_REQUIRED' });
  await assert.rejects(api(request({
    headers: { ...human, origin: 'https://evil.example' },
    body: { messageId: message.id, channel: 'phone' },
  }), url), { code: 'ORIGIN_REJECTED' });
  await assert.rejects(api(request({
    headers: { ...human, 'x-mail-intelligence-request': '' },
    body: { messageId: message.id, channel: 'phone' },
  }), url), { code: 'MUTATION_PROTECTION_REQUIRED' });
  assert.equal(store.getHandledElsewhere(mailbox.id, message.id), null);
});

test('marking drops the reply gap, cancels the pending draft, and undo restores the gap', async (t) => {
  const { store, mailbox, message } = await withStore(t);
  const gapBefore = annotateReplyGaps(store.db, mailbox.id, [{
    id: 'graph-lotte',
    subject: '롯데 내포',
    sender_email: 'lotte@example.com',
    received_at: '2026-10-01T01:00:00.000Z',
    classification: { workState: 'action_required' },
    well_known_name: 'inbox',
  }]);
  assert.equal(gapBefore[0].replyGap, true);
  assert.equal(needsUnansweredReply({ ...gapBefore[0], handledElsewhere: { channel: 'kakao' } }, []), false);
  const drafts = new MailSendDrafts(store.db, { now: () => '2026-10-01T02:30:00.000Z' });
  const created = drafts.create(mailbox.id, 'jarvis', {
    request_id: 'handled-elsewhere-1',
    to: ['lotte@example.com'],
    subject: 'RE: 롯데 내포',
    body_text: '확인 후 회신드리겠습니다.',
    message_id: message.id,
  });
  assert.equal(created.draft.status, 'needs_approval');
  const api = apiFor(store, mailbox);
  const marked = await api(request({
    headers: human,
    body: { messageId: message.id, channel: 'kakao', note: '10/1' },
  }), url);
  assert.equal(marked.status, 200);
  assert.equal(marked.body.replyGap, false);
  assert.equal(marked.body.handledElsewhere.channel, 'kakao');
  assert.equal(marked.body.cancelledDrafts, 1);
  assert.equal(store.db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id = ?').get(created.draft.draft_id).status, 'cancelled');
  const gapAfter = annotateReplyGaps(store.db, mailbox.id, [{
    id: 'graph-lotte',
    classification: { workState: 'action_required' },
    well_known_name: 'inbox',
  }]);
  assert.equal(gapAfter[0].replyGap, false);
  assert.equal(gapAfter[0].handledElsewhere.channel, 'kakao');
  const pipeline = runReplyDraftPipeline({
    db: store.db,
    drafts,
    dryRun: true,
    mailboxId: mailbox.id,
    messages: [{
      id: message.id,
      mailbox_id: mailbox.id,
      subject: '롯데 내포',
      sender_email: 'lotte@example.com',
      body_text: '회신 부탁드립니다.',
      well_known_name: 'inbox',
      classification: { workState: 'action_required' },
    }],
  });
  assert.equal(pipeline.bySkip.handled_elsewhere, 1);
  assert.equal(pipeline.wouldDraft, 0);
  const undone = await api(request({
    headers: human,
    body: { messageId: 'graph-lotte', undo: true },
  }), url);
  assert.equal(undone.body.undone, true);
  assert.equal(undone.body.replyGap, true);
  assert.equal(store.getHandledElsewhere(mailbox.id, message.id), null);
});
