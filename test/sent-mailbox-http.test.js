import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const operatorKey = 'fixture-operator-key-012345678901234567890123';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function seedSentFixture(dataDir) {
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
  const runId = store.startSyncRun({ mailboxId: mailbox.id, folderId: sent.id, runType: 'initial' });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: sent.id,
    syncRunId: runId,
    pageIndex: 0,
    requestUrl: 'https://graph.example/sent/delta',
    items: [normalizeGraphMessage({
      id: 'graph-sent-fixture',
      conversationId: 'conv-sent-24',
      subject: 'Re: 견적 회신',
      from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } },
      toRecipients: [{ emailAddress: { address: 'buyer@example.com', name: 'Buyer' } }],
      sentDateTime: '2026-10-10T09:00:00.000Z',
      receivedDateTime: '2026-10-10T09:00:00.000Z',
      bodyPreview: '견적서 보내드립니다.',
      body: { contentType: 'text', content: '견적서 보내드립니다.' },
      parentFolderId: 'sent-graph',
    })],
    deltaLink: 'https://graph.example/sent/delta',
  });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: inbox.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: inbox.id, runType: 'initial' }),
    pageIndex: 0,
    requestUrl: 'https://graph.example/inbox/delta',
    items: [normalizeGraphMessage({
      id: 'graph-inbox-fixture',
      conversationId: 'conv-inbox-gap',
      subject: '납기 확인 요청',
      from: { emailAddress: { address: 'partner@example.com', name: 'Partner' } },
      toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
      receivedDateTime: '2026-10-09T08:00:00.000Z',
      bodyPreview: '회신 부탁드립니다.',
      body: { contentType: 'text', content: '회신 부탁드립니다.' },
      parentFolderId: 'inbox-graph',
    })],
    deltaLink: 'https://graph.example/inbox/delta',
  });
  const inboxRow = store.db.prepare('SELECT id FROM messages WHERE graph_id = ?').get('graph-inbox-fixture');
  const now = '2026-10-09T08:00:00.000Z';
  store.db.prepare(`
    INSERT INTO precision_classifications(
      message_id, mailbox_id, work_state, next_actor, priority, fingerprint, analyzed_at, created_at, updated_at, source
    ) VALUES (?, ?, 'action_required', 'me', 'normal', 'fp-gap', ?, ?, ?, 'rules')
  `).run(inboxRow.id, mailbox.id, now, now, now);
  store.close();
}

test('GET /api/mail/sent is read-only and returns newest sent messages with search', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-sent-http-'));
  await seedSentFixture(dataDir);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
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
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'opaque-fixture-without-send-scope',
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
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch { /* startup race */ }
    await delay(50);
  }
  assert.equal(healthy, true);
  const root = await fetch(base, {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
  });
  const cookie = root.headers.get('set-cookie').split(';')[0];
  await root.arrayBuffer();
  const list = await fetch(`${base}/api/mail/sent?limit=10`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.readOnly, true);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].subject, 'Re: 견적 회신');
  assert.deepEqual(body.messages[0].to, ['buyer@example.com']);
  const search = await fetch(`${base}/api/mail/sent?q=${encodeURIComponent('견적')}`, { headers: { Cookie: cookie } });
  assert.equal((await search.json()).messages.length, 1);
  const miss = await fetch(`${base}/api/mail/sent?q=${encodeURIComponent('없는제목')}`, { headers: { Cookie: cookie } });
  assert.equal((await miss.json()).messages.length, 0);
  assert.equal((await fetch(`${base}/api/mail/sent`, { method: 'POST', headers: { Cookie: cookie } })).status, 405);
});
