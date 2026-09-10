import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const accessKey = 'grok-api-access-key-0123456789abcdef0123';
const draftToken = 'grok-draft-token-0123456789abcdef01234567';
const serviceToken = 'grok-service-token-0123456789abcdef0123';

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function graphMessage(id, subject, body, overrides = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { address: 'customer@example.com', name: '고객 담당자' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    receivedDateTime: '2026-08-30T00:00:00.000Z',
    sentDateTime: '2026-08-30T00:00:00.000Z',
    createdDateTime: '2026-08-30T00:00:00.000Z',
    lastModifiedDateTime: '2026-08-30T00:00:00.000Z',
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
    parentFolderId: 'inbox',
    ...overrides,
  });
}

function seedDatabase(dataDir) {
  const store = new SQLiteMailStore({
    databasePath: join(dataDir, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('action-api', '[선진 HCI] 수정 견적서 요청', '오늘 오후 3시까지 수정 견적서를 보내주세요.', {
      hasAttachments: true,
      attachments: [{
        id: 'attachment-api-1',
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: '견적서.pdf',
        contentType: 'application/pdf',
        size: 12,
        isInline: false,
      }],
    }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('waiting-api', '[Ticket #ABCDE] 원격지원 일정', '내일 오전 11시에 지원 세션을 진행하겠습니다.'),
  });
  store.db.prepare('UPDATE attachments SET source_json = ? WHERE graph_id = ?').run(
    JSON.stringify({ contentBytes: Buffer.from('%PDF-fixture').toString('base64') }),
    'attachment-api-1',
  );
  store.close();
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Starting.
    }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${logs.join('')}`);
}

async function api(baseUrl, path, {
  method = 'GET',
  token = '',
  cookie = '',
  extraHeaders = {},
  body,
} = {}) {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const parsed = contentType.includes('application/json')
    ? await response.json()
    : await response.arrayBuffer();
  return { response, body: parsed };
}

function startGraphStub(port) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.method === 'POST' && String(req.url || '').endsWith('/sendMail')) {
      res.writeHead(202, { 'request-id': 'graph-receipt-test-1' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise({ server, calls }));
  });
}

async function spawnApp(t, {
  allowSend = '0',
  actionsApproved = '0',
  graphPort,
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-grok-api-'));
  seedDatabase(dataDir);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: accessKey,
      MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: draftToken,
      MAIL_INTELLIGENCE_GROK_SERVICE_TOKEN: serviceToken,
      MAIL_INTELLIGENCE_ALLOW_SEND: allowSend,
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: actionsApproved,
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_GRAPH_BASE_URL: `http://127.0.0.1:${graphPort}`,
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'test-graph-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await delay(100);
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child, logs);
  return { baseUrl, logs };
}

async function humanSession(baseUrl) {
  const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
  const response = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(response.status, 200, await response.text());
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mi_session=/);
  return cookie;
}

test('service tokens can search and read but cannot approve or send', async (t) => {
  const graphPort = await freePort();
  const graph = await startGraphStub(graphPort);
  t.after(() => new Promise((resolveClose) => graph.server.close(resolveClose)));
  const { baseUrl } = await spawnApp(t, { graphPort });

  const denied = await api(baseUrl, '/api/mail/search?q=선진&limit=10');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.code, 'ACCESS_REQUIRED');

  const search = await api(baseUrl, '/api/mail/search?q=선진&limit=10', { token: draftToken });
  assert.equal(search.response.status, 200, JSON.stringify(search.body));
  assert.ok(search.body.results.some((item) => item.id === 'action-api'));

  const intelligence = await api(baseUrl, `/api/intelligence/search?q=${encodeURIComponent('내가 처리할 견적')}&limit=10`, {
    token: draftToken,
  });
  assert.equal(intelligence.response.status, 200, JSON.stringify(intelligence.body));

  const message = await api(baseUrl, '/api/mail/messages/action-api', { token: serviceToken });
  assert.equal(message.response.status, 200);
  assert.match(message.body.body, /수정 견적서/);

  const summary = await api(baseUrl, '/api/intelligence/message-summary?messageId=action-api', { token: serviceToken });
  assert.equal(summary.response.status, 200);
  const thread = await api(baseUrl, '/api/intelligence/thread-summary?messageId=action-api', { token: serviceToken });
  assert.equal(thread.response.status, 200);

  const lanes = await api(baseUrl, '/api/mail/lanes?lane=do_now&limit=10', { token: draftToken });
  assert.equal(lanes.response.status, 200, JSON.stringify(lanes.body));
  assert.equal(lanes.body.lane, 'do_now');
  assert.ok(lanes.body.results.some((item) => item.messageId === 'action-api'));

  const attachments = await api(baseUrl, '/api/mail/attachments?messageId=action-api', { token: draftToken });
  assert.equal(attachments.response.status, 200);
  assert.equal(attachments.body.attachments[0].id, 'attachment-api-1');
  assert.equal(attachments.body.attachments[0].downloadAllowed, true);

  const download = await api(baseUrl, '/api/mail/attachments/attachment-api-1/content?messageId=action-api', {
    token: draftToken,
  });
  assert.equal(download.response.status, 200, typeof download.body === 'object' && !(download.body instanceof ArrayBuffer) ? JSON.stringify(download.body) : download.response.status);
  assert.equal(Buffer.from(download.body).toString(), '%PDF-fixture');

  const created = await api(baseUrl, '/api/mail/send-drafts', {
    method: 'POST',
    token: draftToken,
    body: {
      to: 'person@example.com',
      subject: '윤비서 초안',
      body: '사람 승인 후 발송',
      notes: 'grok-bot',
      attachmentRefs: [{ messageId: 'action-api', attachmentId: 'attachment-api-1' }],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.source, 'grok-bot');
  assert.equal(created.body.status, 'needs_approval');

  const status = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}`, { token: draftToken });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.status, 'needs_approval');

  const approveDenied = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}/approve`, {
    method: 'POST',
    token: draftToken,
    body: {},
  });
  assert.equal(approveDenied.response.status, 403);
  assert.equal(approveDenied.body.code, 'HUMAN_APPROVAL_REQUIRED');

  const cancelDenied = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}/cancel`, {
    method: 'POST',
    token: serviceToken,
    body: {},
  });
  assert.equal(cancelDenied.response.status, 403);
  assert.equal(cancelDenied.body.code, 'HUMAN_APPROVAL_REQUIRED');

  const serviceCreate = await api(baseUrl, '/api/mail/send-drafts', {
    method: 'POST',
    token: serviceToken,
    body: { to: 'person@example.com', subject: 'x', body: 'y' },
  });
  assert.equal(serviceCreate.response.status, 403);
  assert.equal(serviceCreate.body.code, 'DRAFT_SCOPE_REQUIRED');

  const directSend = await api(baseUrl, '/api/outlook/send', {
    method: 'POST',
    token: draftToken,
    body: { to: 'person@example.com', subject: 'x', body: 'y' },
  });
  assert.equal(directSend.response.status, 403);
  assert.equal(directSend.body.code, 'HUMAN_APPROVAL_REQUIRED');

  const cookie = await humanSession(baseUrl);
  const blocked = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}/approve`, {
    method: 'POST',
    cookie,
    extraHeaders: { 'X-Mail-Intelligence-Request': '1' },
    body: {},
  });
  assert.equal(blocked.response.status, 403);
  assert.equal(blocked.body.code, 'EXTERNAL_ACTION_DISABLED');
  assert.equal(graph.calls.length, 0);
});

test('human session can approve a draft only when send is explicitly enabled', async (t) => {
  const graphPort = await freePort();
  const graph = await startGraphStub(graphPort);
  t.after(() => new Promise((resolveClose) => graph.server.close(resolveClose)));
  const { baseUrl } = await spawnApp(t, {
    allowSend: '1',
    actionsApproved: '1',
    graphPort,
  });

  const created = await api(baseUrl, '/api/mail/send-drafts', {
    method: 'POST',
    token: draftToken,
    body: {
      to: 'person@example.com',
      subject: '승인 후 발송',
      body: '영수증 확인 대상',
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));

  const cookie = await humanSession(baseUrl);
  const approved = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}/approve`, {
    method: 'POST',
    cookie,
    extraHeaders: { 'X-Mail-Intelligence-Request': '1' },
    body: {},
  });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'sent');
  assert.equal(approved.body.receipt.adapter, 'microsoft-graph');
  assert.equal(approved.body.receipt.httpStatus, 202);
  assert.ok(approved.body.receipt.submittedAt);
  assert.equal(graph.calls.some((item) => item.url.endsWith('/sendMail')), true);

  const verified = await api(baseUrl, `/api/mail/send-drafts/${created.body.id}`, { token: draftToken });
  assert.equal(verified.body.status, 'sent');
  assert.equal(verified.body.receipt.requestId, 'graph-receipt-test-1');
});
