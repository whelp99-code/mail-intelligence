import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const operatorKey = 'fixture-operator-key-012345678901234567890123';

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  return server.address().port;
}

function startGraphMock() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://graph.fixture');
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (url.pathname.endsWith('/mailFolders')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        value: [
          { id: 'inbox-graph', displayName: 'Inbox', parentFolderId: '', childFolderCount: 0 },
          { id: 'sent-graph', displayName: 'Sent Items', parentFolderId: '', childFolderCount: 0 },
        ],
      }));
      return;
    }
    if (url.pathname.includes('/messages/delta')) {
      const deltaLink = `http://127.0.0.1:${server.address().port}${url.pathname}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: [], '@odata.deltaLink': deltaLink }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function seedReplyCancelFixture(dataDir, graphPort) {
  const graphBase = `http://127.0.0.1:${graphPort}/v1.0`;
  const store = new SQLiteMailStore({
    databasePath: join(dataDir, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: 'owner@example.com' });
  const inbox = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox-graph',
    wellKnownName: 'inbox',
    displayName: '받은 편지함',
  });
  const sent = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'sent-graph',
    wellKnownName: 'sentitems',
    displayName: '보낸 편지함',
  });
  const inboxRun = store.startSyncRun({ mailboxId: mailbox.id, folderId: inbox.id, runType: 'initial' });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: inbox.id,
    syncRunId: inboxRun,
    pageIndex: 0,
    requestUrl: `${graphBase}/me/mailFolders/inbox-graph/messages/delta`,
    items: [
      normalizeGraphMessage({
        id: 'graph-inbox-open',
        conversationId: 'conv-reply-open',
        subject: '회신 필요 건',
        from: { emailAddress: { address: 'buyer@example.com', name: 'Buyer' } },
        toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
        receivedDateTime: '2026-10-09T08:00:00.000Z',
        bodyPreview: '회신 부탁드립니다.',
        body: { contentType: 'text', content: '회신 부탁드립니다.' },
        parentFolderId: 'inbox-graph',
      }),
      normalizeGraphMessage({
        id: 'graph-inbox-replied',
        conversationId: 'conv-reply-done',
        subject: '이미 회신한 건',
        from: { emailAddress: { address: 'lee@example.com', name: 'Lee' } },
        toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
        receivedDateTime: '2026-10-09T09:00:00.000Z',
        bodyPreview: '검토 부탁드립니다.',
        body: { contentType: 'text', content: '검토 부탁드립니다.' },
        parentFolderId: 'inbox-graph',
      }),
    ],
    deltaLink: `${graphBase}/me/mailFolders/inbox-graph/messages/delta`,
  });
  const sentRun = store.startSyncRun({ mailboxId: mailbox.id, folderId: sent.id, runType: 'initial' });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: sent.id,
    syncRunId: sentRun,
    pageIndex: 0,
    requestUrl: `${graphBase}/me/mailFolders/sent-graph/messages/delta`,
    items: [normalizeGraphMessage({
      id: 'graph-sent-reply',
      conversationId: 'conv-reply-done',
      subject: 'Re: 이미 회신한 건',
      from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } },
      toRecipients: [{ emailAddress: { address: 'lee@example.com', name: 'Lee' } }],
      sentDateTime: '2026-10-09T10:00:00.000Z',
      receivedDateTime: '2026-10-09T10:00:00.000Z',
      bodyPreview: '확인했습니다.',
      body: { contentType: 'text', content: '확인했습니다.' },
      parentFolderId: 'sent-graph',
    })],
    deltaLink: `${graphBase}/me/mailFolders/sent-graph/messages/delta`,
  });
  const classify = (graphId, fingerprint) => {
    const row = store.db.prepare('SELECT id FROM messages WHERE graph_id = ?').get(graphId);
    const now = '2026-10-09T08:00:00.000Z';
    store.db.prepare(`
      INSERT INTO precision_classifications(
        message_id, mailbox_id, work_state, next_actor, priority, fingerprint, analyzed_at, created_at, updated_at, source
      ) VALUES (?, ?, 'action_required', 'me', 'normal', ?, ?, ?, ?, 'rules')
    `).run(row.id, mailbox.id, fingerprint, now, now, now);
    return row.id;
  };
  const openId = classify('graph-inbox-open', 'fp-open');
  const repliedId = classify('graph-inbox-replied', 'fp-replied');
  const drafts = new MailSendDrafts(store.db, { now: () => '2026-10-09T11:00:00.000Z' });
  const openDraft = drafts.create(mailbox.id, 'jarvis', {
    request_id: 'reply-open',
    to: ['buyer@example.com'],
    subject: 'RE: 회신 필요 건',
    body_text: '확인하겠습니다.',
    message_id: openId,
  }).draft;
  const repliedDraft = drafts.create(mailbox.id, 'jarvis', {
    request_id: 'reply-done',
    to: ['lee@example.com'],
    subject: 'RE: 이미 회신한 건',
    body_text: '추가 회신 초안입니다.',
    message_id: repliedId,
  }).draft;
  store.close();
  return { openDraftId: openDraft.draft_id, repliedDraftId: repliedDraft.draft_id };
}

async function openSession(base) {
  const root = await fetch(base, {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
  });
  const cookie = root.headers.get('set-cookie').split(';')[0];
  await root.arrayBuffer();
  const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json();
  return { cookie, session, base };
}

test('POST /api/outlook/sync cancels answered reply drafts and keeps unanswered ones', async (t) => {
  const graph = startGraphMock();
  const graphPort = await listen(graph);
  t.after(() => new Promise((resolve) => graph.close(() => resolve())));

  const dataDir = await mkdtemp(join(tmpdir(), 'mail-reply-cancel-http-'));
  const { openDraftId, repliedDraftId } = await seedReplyCancelFixture(dataDir, graphPort);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const graphBase = `http://127.0.0.1:${graphPort}/v1.0`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_GRAPH_BASE_URL: graphBase,
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'fixture-graph-token-for-sync',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch { /* startup race */ }
    await delay(50);
  }

  const { cookie, session } = await openSession(base);
  const sync = await fetch(`${base}/api/outlook/sync`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: base,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
      'x-mail-intelligence-request': '1',
    },
    body: JSON.stringify({ top: 25, forceInitial: false }),
  });
  assert.equal(sync.status, 200, await sync.text());

  const drafts = await (await fetch(`${base}/api/mail/send-drafts`, { headers: { Cookie: cookie } })).json();
  const byId = new Map(drafts.drafts.map((draft) => [draft.draft_id, draft]));
  assert.equal(byId.get(openDraftId).status, 'needs_approval');
  assert.equal(byId.get(openDraftId).system_cancelled, false);
  assert.equal(byId.get(repliedDraftId).status, 'cancelled');
  assert.equal(byId.get(repliedDraftId).system_cancelled, true);

  const cancelled = await (await fetch(`${base}/api/mail/send-drafts/${repliedDraftId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(cancelled.draft.status, 'cancelled');
  assert.equal(cancelled.draft.system_cancelled, true);

  const inbox = await (await fetch(`${base}/api/outlook/messages?top=25`, { headers: { Cookie: cookie } })).json();
  const openMessage = inbox.messages.find((message) => message.subject === '회신 필요 건');
  const repliedMessage = inbox.messages.find((message) => message.subject === '이미 회신한 건');
  assert.equal(openMessage.replyGap, true);
  assert.equal(repliedMessage.replyGap, false);
});
