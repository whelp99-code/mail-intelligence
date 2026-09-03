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
        size: 2048,
        isInline: false,
      }],
    }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('waiting-api', '[Ticket #ABCDE] 원격지원 일정', '내일 오전 11시에 지원 세션을 진행하겠습니다.'),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('reference-api', '뉴스레터', '이번 달 주요 소식입니다. 별도 회신은 필요 없습니다.'),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('review-api', '신규 전자세금계산서 도착', '신규 전자세금계산서가 도착했습니다. 내용을 확인해 주세요.'),
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

test('v1.2.2 intelligence APIs provide safe operational lanes, summaries, drafts, and corrections', async (t) => {
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
  assert.equal(health.precisionClassificationVersion, 'precision-classification-v1.2.2-fix9');
  assert.equal(health.operationalClassificationVersion, 'operational-classification-v1.2.2');
  assert.equal(health.mailAssistantToolsVersion, 'mail-assistant-tools-v1.2.2');

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
  assert.equal(result.body.total, 4);
  assert.equal(result.body.states.action_required, 1);
  assert.equal(result.body.states.waiting, 1);
  assert.equal(result.body.states.reference, 2);
  assert.equal(result.body.states.review_required, 0);
  assert.equal(result.body.calculated.operational.lanes.do_now, 1);
  assert.equal(result.body.calculated.operational.lanes.waiting, 1);
  assert.ok(result.body.calculated.operational.lanes.review >= 1);

  result = await api(baseUrl, '/api/intelligence/operational-summary', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.version, 'operational-classification-v1.2.2');
  assert.equal(result.body.total, 4);

  result = await api(baseUrl, '/api/intelligence/message-summary?messageId=action-api', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.currentContentOnly, true);
  assert.match(result.body.oneLine, /견적서/);

  result = await api(baseUrl, '/api/intelligence/thread-summary?messageId=action-api', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.messageCount, 1);

  result = await api(baseUrl, '/api/intelligence/meeting-candidate?messageId=waiting-api', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.meetingIntent, true);
  assert.equal(result.body.availability, 'unknown');
  assert.equal(result.body.calendarWriteAllowed, false);

  result = await api(baseUrl, '/api/intelligence/attachments?messageId=action-api', { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.attachments.length, 1);
  assert.equal(result.body.summaries[0].summaryStatus, 'metadata_only');
  assert.equal(result.body.summaries[0].affectsClassification, false);

  result = await api(baseUrl, '/api/intelligence/personality', { cookie });
  assert.equal(result.response.status, 200);
  assert.ok(result.body.personality.role);

  result = await api(baseUrl, '/api/intelligence/personality', {
    method: 'POST', cookie, csrfToken: session.csrfToken,
    body: { role: '기술 엔지니어', tone: '간결하고 전문적', opening: '안녕하세요, 기술지원팀입니다.' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.personality.role, '기술 엔지니어');

  result = await api(baseUrl, '/api/intelligence/draft', {
    method: 'POST', cookie, csrfToken: session.csrfToken,
    body: { messageId: 'action-api', mode: 'rapid_reply' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.sendAllowed, false);
  assert.equal(result.body.requiresHumanApproval, true);
  assert.equal(result.body.action, 'copy_only');

  result = await api(baseUrl, '/api/intelligence/attachment-summary', {
    method: 'POST', cookie, csrfToken: session.csrfToken,
    body: { messageId: 'action-api', attachmentId: 'attachment-api-1' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.summaryStatus, 'metadata_only');

  result = await api(baseUrl, '/api/intelligence/adjudicate', {
    method: 'POST', cookie, csrfToken: session.csrfToken,
    body: { messageId: 'review-api' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.status, 'policy_blocked');
  assert.equal(result.body.code, 'EXTERNAL_AI_DISABLED');
  assert.equal(result.body.fallback, 'rules_review');
  assert.equal(result.body.persisted, false);

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

  result = await api(baseUrl, `/api/intelligence/search?q=${encodeURIComponent('내가 처리할 견적')}`, { cookie });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results.length, 1);
  assert.equal(result.body.results[0].message.id, 'action-api');
  assert.ok(result.body.results[0].matchedBecause.length >= 2);

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
  assert.equal(result.body.processed, 4);

  result = await api(baseUrl, '/api/intelligence/confirm', {
    method: 'POST', cookie, csrfToken: session.csrfToken,
    body: { messageId: 'review-api', note: '사용자가 현재 검토 상태를 확인했습니다.' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.classification.reviewStatus, 'corrected');

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
