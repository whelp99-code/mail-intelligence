import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const operatorKey = 'fixture-operator-key-012345678901234567890123';
const evidenceRoot = process.env.MAIL24_EVIDENCE_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '../.omo/evidence/mail-24');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(2_000) });
    child.kill('SIGTERM');
    try { await exited; } catch {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
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
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: sent.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: sent.id, runType: 'initial' }),
    pageIndex: 0,
    requestUrl: 'https://graph.example/sent/delta',
    items: [
      normalizeGraphMessage({
        id: 'graph-sent-ui-newer',
        conversationId: 'conv-ui',
        subject: 'Re: 견적 회신',
        from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } },
        toRecipients: [{ emailAddress: { address: 'buyer@example.com', name: 'Buyer' } }],
        sentDateTime: '2026-10-10T09:00:00.000Z',
        receivedDateTime: '2026-10-10T09:00:00.000Z',
        bodyPreview: '견적서 보내드립니다.',
        body: { contentType: 'text', content: '견적서 보내드립니다.' },
        parentFolderId: 'sent-graph',
      }),
      normalizeGraphMessage({
        id: 'graph-sent-ui-older',
        conversationId: 'conv-ui-older',
        subject: '납기 안내',
        from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } },
        toRecipients: [{ emailAddress: { address: 'partner@example.com', name: 'Partner' } }],
        sentDateTime: '2026-10-09T08:30:00.000Z',
        receivedDateTime: '2026-10-09T08:30:00.000Z',
        bodyPreview: '납기는 10월 말입니다.',
        body: { contentType: 'text', content: '납기는 10월 말입니다.' },
        parentFolderId: 'sent-graph',
      }),
    ],
    deltaLink: 'https://graph.example/sent/delta',
  });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: inbox.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: inbox.id, runType: 'initial' }),
    pageIndex: 0,
    requestUrl: 'https://graph.example/inbox/delta',
    items: [normalizeGraphMessage({
      id: 'graph-inbox-gap-ui',
      conversationId: 'conv-inbox-gap-ui',
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
  const inboxRow = store.db.prepare('SELECT id FROM messages WHERE graph_id = ?').get('graph-inbox-gap-ui');
  const now = '2026-10-09T08:00:00.000Z';
  store.db.prepare(`
    INSERT INTO precision_classifications(
      message_id, mailbox_id, work_state, next_actor, priority, fingerprint, analyzed_at, created_at, updated_at, source
    ) VALUES (?, ?, 'action_required', 'me', 'normal', 'fp-gap-ui', ?, ?, ?, 'rules')
  `).run(inboxRow.id, mailbox.id, now, now, now);
  store.close();
}

function attachCdp(ws) {
  const pending = new Map();
  let nextId = 0;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'CDP error'));
      else resolve(message.result || {});
    }
  });
  return async (method, params = {}) => {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, method, params }));
    return result;
  };
}

async function waitFor(cdp, expression, timeoutMs = 12_000) {
  return cdp('Runtime.evaluate', {
    expression: `new Promise((resolve, reject) => {
      const check = () => { try { return (${expression}); } catch (error) { reject(error); return null; } };
      const current = check();
      if (current) { resolve(current); return; }
      const observer = new MutationObserver(() => {
        const value = check();
        if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
      });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('UI state timeout')); }, ${timeoutMs});
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    })`,
    awaitPromise: true,
    returnByValue: true,
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result.result?.value;
  });
}

test('issue #24 sent mailbox UI capture at 1440 and 390', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join('/var/tmp', 'mail24-ui-'));
  const profile = join(directory, 'chrome');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await seedSentFixture(directory);
  const appPort = await freePort();
  const debugPort = await freePort();
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: directory,
      MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'opaque-fixture-without-send-scope',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    await stopChild(chrome);
    await stopChild(app);
    await rm(directory, { recursive: true, force: true });
  });
  const ready = async (child, stream, marker) => new Promise((resolve, reject) => {
    const onData = (chunk) => { if (chunk.toString().includes(marker)) { cleanup(); resolve(); } };
    const onExit = (code) => { cleanup(); reject(new Error(`exit ${code}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('startup timeout')); }, 15_000);
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); child.off('exit', onExit); };
    stream.on('data', onData);
    child.on('exit', onExit);
  });
  await Promise.all([
    ready(app, app.stdout, `app running at http://127.0.0.1:${appPort}`),
    ready(chrome, chrome.stderr, 'DevTools listening on'),
  ]);
  const created = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await once(ws, 'open');
  const cdp = attachCdp(ws);
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setExtraHTTPHeaders', {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/` });
  await waitFor(cdp, 'document.querySelector("#messageList .reply-gap")?.textContent?.includes("회신 필요")');
  const inboxShot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, 'before-1440.png'), Buffer.from(inboxShot.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: 'document.querySelector("#showSent").click()' });
  await waitFor(cdp, '!document.querySelector("#sentMail").hidden && document.querySelectorAll("#sentList .message-card").length === 2');
  const sent1440 = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(evidenceRoot, 'after-1440.png'), Buffer.from(sent1440.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp('Runtime.evaluate', { expression: 'document.querySelector("#showInbox").click()' });
  await waitFor(cdp, 'document.querySelector("#sentMail").hidden');
  const before390 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(evidenceRoot, 'before-390.png'), Buffer.from(before390.data, 'base64'));
  await cdp('Runtime.evaluate', { expression: 'document.querySelector("#showSent").click()' });
  await waitFor(cdp, '!document.querySelector("#sentMail").hidden && document.querySelectorAll("#sentList .message-card").length === 2');
  const after390 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(evidenceRoot, 'after-390.png'), Buffer.from(after390.data, 'base64'));
  const sentUi = await waitFor(cdp, `(() => {
    const cards = [...document.querySelectorAll('#sentList .message-card')];
    const subjects = cards.map((card) => card.querySelector('.message-subject')?.textContent || '');
    const detailBody = document.querySelector('#sentDetail .detail-body')?.textContent || '';
    const detailMeta = document.querySelector('#sentDetail .detail-meta')?.textContent || '';
    return {
      count: cards.length,
      newestFirst: subjects[0]?.includes('견적') && subjects[1]?.includes('납기'),
      detailBody,
      detailMeta,
    };
  })()`);
  assert.equal(sentUi.count, 2);
  assert.equal(sentUi.newestFirst, true);
  assert.match(sentUi.detailBody, /견적서 보내드립니다/);
  assert.match(sentUi.detailMeta, /2026/);
  ws.close();
});
