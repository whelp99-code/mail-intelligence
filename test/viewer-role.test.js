import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createMailSendApi } from '../src/application/mail-send-api.js';

const operatorKey = 'viewer-role-operator-key-0123456789abcd';
const viewerKey = 'viewer-role-viewer-key-0123456789abcdef';

function rejectViewerWrite(session, req) {
  if (session?.role !== 'viewer') return;
  const method = String(req?.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const path = String(req?.url || '').split('?')[0];
  if (method === 'DELETE' && path === '/api/session') return;
  throw Object.assign(new Error('Viewer sessions cannot change mail state.'), {
    statusCode: 403,
    code: 'VIEWER_WRITE_FORBIDDEN',
  });
}

test('viewer approve does not read the body or call Graph send', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let sends = 0;
  let bodyReads = 0;
  const api = createMailSendApi({
    getStore: () => ({ db }),
    getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => req.headers.cookie === 'viewer' ? { token: 'viewer-token', csrfToken: 'csrf', role: 'viewer' } : { token: 'operator-token', csrfToken: 'csrf', role: 'operator' },
    readBody: async () => { bodyReads += 1; return { request_id: 'api-request-001', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.' }; },
    getAccessToken: async () => { throw new Error('graph token must not be requested'); },
    allowSend: true,
    accessKeyRequired: true,
    companyDomains: ['example.com'],
    rejectViewerWrite,
    viewerAccessKey: viewerKey,
    clientFactory: () => ({
      sendOnce: async () => { sends += 1; return { graphMessageId: 'must-not-send', sentAt: '2026-10-31T00:00:00Z' }; },
      reconcile: async () => ({ uncertain: true }),
    }),
  });
  const operator = await api({
    method: 'POST',
    url: '/api/mail/send-drafts',
    headers: { cookie: 'operator', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'csrf' },
  }, new URL('http://127.0.0.1:3010/api/mail/send-drafts'));
  assert.equal(operator.status, 201);
  const before = db.prepare('SELECT COUNT(*) AS count FROM mail_send_drafts').get().count;
  const readsBeforeViewer = bodyReads;
  await assert.rejects(api({
    method: 'POST',
    url: `/api/mail/send-drafts/${operator.body.draft.draft_id}/approve`,
    headers: { cookie: 'viewer', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'csrf' },
  }, new URL(`http://127.0.0.1:3010/api/mail/send-drafts/${operator.body.draft.draft_id}/approve`)), { code: 'VIEWER_WRITE_FORBIDDEN' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM mail_send_drafts').get().count, before);
  assert.equal(bodyReads, readsBeforeViewer);
  assert.equal(sends, 0);
  await assert.rejects(api({
    method: 'POST',
    url: '/api/mail/send-drafts',
    headers: { authorization: `Bearer ${viewerKey}` },
  }, new URL('http://127.0.0.1:3010/api/mail/send-drafts')), { code: 'DRAFT_TOKEN_REQUIRED' });
  assert.equal(sends, 0);
});

function basic(key) {
  return `Basic ${Buffer.from(`mailintelligence:${key}`, 'utf8').toString('base64')}`;
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test('equal operator and viewer keys refuse boot', async () => {
  const port = await availablePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-viewer-same-key-'));
  let output = '';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_VIEWER_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_ALLOW_SEND: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const code = await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(8_000).then(() => 'timeout'),
  ]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 1);
  assert.match(output, /MAIL_VIEWER_KEY_NOT_DISTINCT/);
  assert.equal(output.includes(operatorKey), false);
  await rm(dataDir, { recursive: true, force: true });
});

test('viewer session is read-only and does not call Graph send', async (t) => {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-viewer-role-'));
  let output = '';
  const env = {
    ...process.env,
    PORT: String(port),
    MAIL_INTELLIGENCE_HOST: '127.0.0.1',
    MAIL_INTELLIGENCE_DATA_DIR: dataDir,
    MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
    MAIL_INTELLIGENCE_VIEWER_ACCESS_KEY: viewerKey,
    MAIL_INTELLIGENCE_ALLOW_SEND: '1',
    MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
    MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
    MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
  };
  delete env.MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN;
  delete env.MAIL_INTELLIGENCE_JARVIS_DRAFT_TOKEN;
  let server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode == null) server.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch { /* starting */ }
    if (attempt === 49) throw new Error(output);
    await delay(100);
  }

  async function login(key) {
    const response = await fetch(`${baseUrl}/`, { headers: { Authorization: basic(key) } });
    assert.equal(response.status, 200);
    return (response.headers.get('set-cookie') || '').split(';')[0];
  }
  const viewerCookie = await login(viewerKey);
  const operatorCookie = await login(operatorKey);
  const viewerSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: viewerCookie } });
  const operatorSession = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: operatorCookie } });
  const viewerBody = await viewerSession.json();
  const operatorBody = await operatorSession.json();
  assert.equal(viewerSession.status, 200);
  assert.equal(operatorSession.status, 200);
  assert.equal(viewerBody.role, 'viewer');
  assert.equal(operatorBody.role, 'operator');

  const dbPath = join(dataDir, 'mail-intelligence.sqlite');
  const sent = await fetch(`${baseUrl}/api/mail/sent`, { headers: { Cookie: viewerCookie } });
  assert.equal(sent.status, 200);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  const mailbox = db.prepare('SELECT id FROM mailboxes LIMIT 1').get();
  const now = '2026-10-31T00:00:00Z';
  db.prepare('INSERT INTO mail_folders(mailbox_id, graph_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(mailbox.id, 'viewer-folder', now, now);
  const folder = db.prepare('SELECT id FROM mail_folders WHERE graph_id = ?').get('viewer-folder');
  db.prepare('INSERT INTO messages(mailbox_id, folder_id, graph_id, subject, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(mailbox.id, folder.id, 'viewer-message', 'viewer fixture', now, now, now);
  const messageId = db.prepare('SELECT id FROM messages WHERE graph_id = ?').get('viewer-message').id;
  db.close();
  assert.equal((await fetch(`${baseUrl}/api/mail/message?id=${messageId}`, { headers: { Cookie: viewerCookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/mail/search?q=viewer`, { headers: { Cookie: viewerCookie } })).status, 200);

  function rows(sql) {
    const handle = new DatabaseSync(dbPath, { readOnly: true });
    try { return handle.prepare(sql).all(); } finally { handle.close(); }
  }
  const draftsBefore = rows('SELECT COUNT(*) AS count FROM mail_send_drafts')[0].count;
  const cursorBefore = JSON.stringify(rows('SELECT graph_id, delta_link, next_link, sync_state FROM mail_folders'));
  async function post(path, cookie = viewerCookie, extra = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: extra.method || 'POST',
      headers: {
        Cookie: cookie,
        Origin: baseUrl,
        'X-Mail-Intelligence-Request': '1',
        'Content-Type': extra.type || 'application/json',
        ...(extra.headers || {}),
      },
      body: extra.body === undefined ? '{}' : extra.body,
    });
  }
  const create = await post('/api/mail/send-drafts');
  const approve = await post('/api/mail/send-drafts/00000000-0000-4000-8000-000000000001/approve');
  assert.equal(create.status, 403);
  assert.equal((await create.json()).code, 'VIEWER_WRITE_FORBIDDEN');
  assert.equal(approve.status, 403);
  assert.equal((await approve.json()).code, 'VIEWER_WRITE_FORBIDDEN');
  assert.equal(rows('SELECT COUNT(*) AS count FROM mail_send_drafts')[0].count, draftsBefore);
  assert.equal(output.includes('sendMail'), false);
  const sync = await post('/api/outlook/sync');
  assert.equal(sync.status, 403);
  assert.equal((await sync.json()).code, 'VIEWER_WRITE_FORBIDDEN');
  assert.equal(JSON.stringify(rows('SELECT graph_id, delta_link, next_link, sync_state FROM mail_folders')), cursorBefore);
  for (const path of ['/api/outlook/read', '/api/outlook/send']) {
    const response = await post(path);
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.code, 'VIEWER_WRITE_FORBIDDEN');
    assert.notEqual(body.code, 'NOT_IMPLEMENTED');
  }
  for (const path of [
    '/api/intelligence/draft',
    '/api/intelligence/confirm',
    '/api/intelligence/correct',
    '/api/intelligence/classify',
    '/api/outlook/config',
    '/api/storage/backup',
    '/api/ai/oauth/test',
    '/api/messages/handled-elsewhere',
    '/api/work-links',
  ]) {
    const response = await post(path);
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).code, 'VIEWER_WRITE_FORBIDDEN', path);
  }
  const upload = await post('/api/mail/attachment-assets', viewerCookie, {
    type: 'application/octet-stream',
    body: 'not-read',
    headers: { 'x-file-name': 'note.txt' },
  });
  const uploadBody = await upload.json();
  assert.equal(upload.status, 403);
  assert.equal(uploadBody.code || uploadBody.error?.code, 'VIEWER_WRITE_FORBIDDEN');
  const bearer = await fetch(`${baseUrl}/api/mail/send-drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${viewerKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(bearer.status, 401);
  assert.equal((await bearer.json()).code, 'DRAFT_TOKEN_REQUIRED');

  const operatorDraft = await post('/api/mail/send-drafts', operatorCookie, {
    body: JSON.stringify({ request_id: 'operator-unchanged', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.' }),
    headers: { 'x-csrf-token': operatorBody.csrfToken },
  });
  assert.equal(operatorDraft.status, 201);
  const removed = await post('/api/session', viewerCookie, { method: 'DELETE', body: '' });
  assert.equal(removed.status, 200);
  const afterDelete = rows('SELECT role FROM browser_sessions');
  assert.equal(afterDelete.some((row) => row.role === 'viewer'), false);
  assert.equal(afterDelete.some((row) => row.role === 'operator'), true);
  assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { Cookie: operatorCookie } })).status, 200);

  server.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(2_000)]);
  output = '';
  server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* starting */ }
    if (attempt === 49) throw new Error(output);
    await delay(100);
  }
  const restored = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: operatorCookie } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).role, 'operator');
  assert.equal(rows('SELECT role FROM browser_sessions').some((row) => row.role === 'operator'), true);
});
