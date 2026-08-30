import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

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

function graphMessage(id, subject, body) {
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
    message: graphMessage('action-api', '[선진 HCI] 수정 견적서 요청', '오늘 오후 3시까지 수정 견적서를 보내주세요.'),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('waiting-api', '정책표 승인', '정책표는 고객 보안팀 승인 대기 상태입니다.'),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('reference-api', '뉴스레터', '이번 달 주요 소식입니다. 별도 회신은 필요 없습니다.'),
  });
  store.close();
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

async function api(baseUrl, path, { method = 'GET', cookie = '', csrfToken = '', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('v1.2.0 precision intelligence APIs are authenticated, correction-safe, and anti-garbage', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-precision-api-'));
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
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
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

  const health = await waitForHealth(baseUrl, child, logs);
  assert.equal(health.storage.schemaVersion, 4);
  assert.equal(health.safety.mode, 'read-only');
  assert.equal(health.graphConsent.includes('Mail.Send'), false);

  let result = await api(baseUrl, '/api/intelligence/summary');
  assert.equal(result.response.status, 401);

  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = (sessionResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  assert.ok(session.csrfToken);

  result = await api(baseUrl, '/api/intelligence/summary', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.total, 3);
  assert.equal(result.body.states.action_required, 1);
  assert.equal(result.body.states.waiting, 1);
  assert.equal(result.body.states.reference, 1);

  result = await api(baseUrl, '/api/intelligence/projects', { cookie });
  assert.deepEqual(result.body.projects, []);

  result = await api(baseUrl, '/api/intelligence/projects', {
    method: 'POST',
    cookie,
    body: { name: '선진엔지니어링 HCI 구축', aliases: ['선진 HCI'] },
  });
  assert.equal(result.response.status, 403);

  result = await api(baseUrl, '/api/intelligence/projects', {
    method: 'POST',
    cookie,
    csrfToken: session.csrfToken,
    body: { name: '선진엔지니어링 HCI 구축', projectKey: 'sunjin-hci', aliases: ['선진 HCI'] },
  });
  assert.equal(result.response.status, 201);
  const projectId = result.body.project.id;
  assert.ok(projectId);

  result = await api(baseUrl, '/api/intelligence/projects', {
    method: 'POST',
    cookie,
    csrfToken: session.csrfToken,
    body: { name: '중복 프로젝트', aliases: ['선진 HCI'] },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'PROJECT_ALIAS_CONFLICT');

  result = await api(baseUrl, '/api/intelligence/classification?messageId=action-api', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.classification.workState, 'action_required');
  assert.equal(result.body.classification.projectResolution, 'confirmed');
  assert.equal(result.body.classification.primaryProjectId, projectId);

  result = await api(baseUrl, `/api/intelligence/search?q=${encodeURIComponent('오늘 내가 처리할 견적')}`, { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].message.id, 'action-api');
  assert.ok(result.body.results[0].matchedBecause.length >= 3);

  result = await api(baseUrl, '/api/intelligence/correct', {
    method: 'POST',
    cookie,
    csrfToken: session.csrfToken,
    body: {
      messageId: 'action-api',
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
      clearProject: true,
      reasonCode: 'not-work',
      note: '사용자가 참고 메일로 확인함',
    },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.classification.workState, 'reference');
  assert.equal(result.body.classification.reviewStatus, 'corrected');

  result = await api(baseUrl, '/api/intelligence/classify', {
    method: 'POST',
    cookie,
    csrfToken: session.csrfToken,
    body: { force: true },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.processed, 3);

  result = await api(baseUrl, '/api/intelligence/classification?messageId=action-api', { cookie });
  assert.equal(result.body.classification.workState, 'reference');
  assert.equal(result.body.correction.reasonCode, 'not-work');

  result = await api(baseUrl, '/api/intelligence/smart-views', { cookie });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.views.some((view) => view.id === 'review-required'));

  result = await api(baseUrl, '/api/outlook/send', {
    method: 'POST',
    cookie,
    csrfToken: session.csrfToken,
    body: {},
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'EXTERNAL_ACTION_DISABLED');
});
