import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/chromium';
const operatorKey = 'fixture-operator-key-012345678901234567890123';
const evidenceRoot = process.env.MAIL69_EVIDENCE_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '../.omo/evidence/mail-69');

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

async function seedCancelledDraft(dataDir) {
  const store = new SQLiteMailStore({
    databasePath: join(dataDir, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: 'owner@example.com' });
  const inbox = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox-graph', wellKnownName: 'inbox', displayName: '받은 편지함' });
  store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: inbox.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: inbox.id, runType: 'initial' }),
    pageIndex: 0,
    requestUrl: 'https://graph.example/inbox/delta',
    items: [normalizeGraphMessage({
      id: 'graph-in-1',
      conversationId: 'conv-69',
      subject: '견적 회신 요청',
      from: { emailAddress: { address: 'buyer@example.com' } },
      receivedDateTime: '2026-10-10T08:00:00.000Z',
      bodyPreview: '회신 부탁',
      body: { contentType: 'text', content: '회신 부탁드립니다.' },
      parentFolderId: 'inbox-graph',
    })],
    deltaLink: 'https://graph.example/inbox/delta',
  });
  const messageId = store.db.prepare('SELECT id FROM messages WHERE graph_id = ?').get('graph-in-1').id;
  const drafts = new MailSendDrafts(store.db, { now: () => '2026-10-10T09:00:00.000Z' });
  const created = drafts.create(mailbox.id, 'jarvis', {
    request_id: 'mail-69-restore-ui',
    to: ['buyer@example.com'],
    subject: 'RE: 견적 회신 요청',
    body_text: '수정된 회신 본문입니다.',
    message_id: messageId,
  }).draft;
  drafts.cancel(mailbox.id, created.draft_id, 'system:already-replied', '이미 회신함');
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

test('issue #69 restore button visible at 390px', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join('/var/tmp', 'mail69-ui-'));
  await seedCancelledDraft(directory);
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
    `--user-data-dir=${join(directory, 'chrome')}`,
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp('Page.navigate', { url: `http://127.0.0.1:${appPort}/#sendDraftReview` });
  await waitFor(cdp, 'document.querySelector("#sendDraftList button")');
  await cdp('Runtime.evaluate', { expression: 'document.querySelector("#sendDraftList button").click()' });
  await waitFor(cdp, 'document.querySelector("#restoreSendDraft")');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, 'restore-390.png'), Buffer.from(shot.data, 'base64'));
  const label = await waitFor(cdp, 'document.querySelector("#restoreSendDraft")?.textContent');
  assert.equal(label, '초안 복구');
  ws.close();
});
