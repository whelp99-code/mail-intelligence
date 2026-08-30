import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const accessKey = 'ai-enrichment-access-key-0123456789';

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function waitForHealth(baseUrl, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.service === 'mail-intelligence') return;
    } catch {
      // App is still starting.
    }
    await delay(100);
  }
  throw new Error(`Mail Intelligence did not become healthy. Output: ${output.join('')}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(1_000)
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function basicAuthorization() {
  return `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
}

function graphMessage({ id, changeKey, subject, receivedAt, body }) {
  return {
    id,
    changeKey,
    subject,
    from: { emailAddress: { address: 'customer@example.com', name: '고객 담당자' } },
    sender: { emailAddress: { address: 'customer@example.com', name: '고객 담당자' } },
    ccRecipients: [],
    receivedDateTime: receivedAt,
    importance: 'normal',
    isRead: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`
  };
}

function aiPayload(message, status, summary) {
  return {
    messages: [{
      id: message.id,
      status,
      summary: [summary],
      nextActions: [{
        recommendedAction: status === 'urgent' ? '오늘 중 고객에게 진행 일정을 회신' : '필요한 승인 상태를 확인',
        owner: '박재민',
        due: status === 'urgent' ? '오늘' : '',
        priority: status === 'urgent' ? 1 : 3,
        lane: status,
        evidence: message.bodyPreview,
        intent: '메일의 명시적 요청에 대응',
        to: 'customer@example.com',
        subject: `RE: ${message.subject}`,
        body: '검증된 AI 회신 초안'
      }],
      evidenceItems: [message.bodyPreview],
      aiRationale: '메일 본문의 요청과 상태 표현을 근거로 판단'
    }]
  };
}

test('실제 API 경로에서 AI 분석과 F-AIOS→LM Studio 폴백 메타데이터가 정확하다', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-ai-enrichment-'));
  const first = graphMessage({
    id: 'ai-mail-1',
    changeKey: 'v1',
    subject: '오늘 중 일정 회신 요청',
    receivedAt: '2026-08-28T01:00:00.000Z',
    body: '오늘 중으로 진행 일정을 회신 부탁드립니다.'
  });
  const second = graphMessage({
    id: 'ai-mail-2',
    changeKey: 'v1',
    subject: '승인 상태 확인 요청',
    receivedAt: '2026-08-28T02:00:00.000Z',
    body: '내부 승인 상태를 확인한 뒤 알려주세요.'
  });

  let graphMessages = [first];
  let activeAiMessage = first;
  let providerMode = 'faios-success';
  let faiosCalls = 0;
  let lmStudioCalls = 0;

  const mockServer = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/v1.0/me/mailFolders') {
      assert.match(String(req.headers.authorization || ''), /^Bearer /);
      jsonResponse(res, 200, {
        value: [{
          id: 'inbox',
          displayName: 'Inbox',
          parentFolderId: '',
          childFolderCount: 0,
          totalItemCount: graphMessages.length,
          unreadItemCount: graphMessages.filter((message) => !message.isRead).length,
          isHidden: false,
        }],
      });
      return;
    }

    if (url.pathname === '/v1.0/me/mailFolders/inbox/messages/delta') {
      assert.match(String(req.headers.authorization || ''), /^Bearer /);
      jsonResponse(res, 200, {
        value: graphMessages,
        '@odata.deltaLink': `${mockBaseUrl}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=${encodeURIComponent(activeAiMessage.id)}`,
      });
      return;
    }

    if (url.pathname === '/api/workflow/execute') {
      faiosCalls += 1;
      await readBody(req);
      if (providerMode === 'faios-failure') {
        jsonResponse(res, 503, { message: 'temporary F-AIOS failure' });
        return;
      }
      jsonResponse(res, 200, {
        response: JSON.stringify(aiPayload(activeAiMessage, 'urgent', 'F-AIOS 정상 분석 요약'))
      });
      return;
    }

    if (url.pathname === '/v1/chat/completions') {
      lmStudioCalls += 1;
      await readBody(req);
      jsonResponse(res, 200, {
        choices: [{
          message: {
            content: JSON.stringify(aiPayload(activeAiMessage, 'waiting', 'LM Studio 폴백 분석 요약'))
          }
        }]
      });
      return;
    }

    jsonResponse(res, 404, { message: 'mock route not found' });
  });

  const mockPort = await listen(mockServer);
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  const appPort = await freePort();
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  await writeFile(join(dataDir, '.outlook-config.json'), JSON.stringify({
    tenantId: '',
    clientId: '',
    mailboxUser: '',
    loginTenant: 'common',
    geminiModel: 'gemini-2.5-flash',
    expiresAt: 0,
    aiProvider: 'f-aios-v3',
    faiosServerUrl: mockBaseUrl,
    lmstudioModel: 'integration-model',
    lmstudioServerUrl: mockBaseUrl,
    domainProfile: 'generic'
  }, null, 2), 'utf8');

  const output = [];
  const app = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: accessKey,
      MAIL_INTELLIGENCE_GRAPH_BASE_URL: `${mockBaseUrl}/v1.0`,
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'integration-graph-token',
      MAIL_INTELLIGENCE_HTTP_TIMEOUT_MS: '2000',
      MAIL_INTELLIGENCE_AI_TIMEOUT_MS: '2000',
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stdout.on('data', (chunk) => output.push(chunk.toString()));
  app.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(appBaseUrl, output);
    const root = await fetch(`${appBaseUrl}/`, {
      headers: { Authorization: basicAuthorization() }
    });
    assert.equal(root.status, 200);
    const cookie = (root.headers.get('set-cookie') || '').split(';')[0];

    const firstResponse = await fetch(`${appBaseUrl}/api/outlook/analyze?top=1`, {
      headers: { Cookie: cookie }
    });
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.aiError, null);
    assert.equal(firstBody.result.ai.enabled, true);
    assert.equal(firstBody.result.ai.provider, 'f-aios-v3');
    assert.equal(firstBody.result.ai.requestedProvider, 'f-aios-v3');
    assert.equal(firstBody.result.ai.fallback, null);
    assert.match(firstBody.result.ai.policyVersion, /^mail-intelligence-v1\.0\.1-prompt-/);
    const firstInsight = firstBody.result.messageInsights.find((item) => item.id === first.id);
    assert.equal(firstInsight.aiEnhanced, true);
    assert.equal(firstInsight.status, 'urgent');
    assert.equal(firstInsight.summary[0], 'F-AIOS 정상 분석 요약');
    assert.equal(faiosCalls, 1);
    assert.equal(lmStudioCalls, 0);

    graphMessages = [second];
    activeAiMessage = second;
    providerMode = 'faios-failure';

    const secondResponse = await fetch(`${appBaseUrl}/api/outlook/analyze?top=1`, {
      headers: { Cookie: cookie }
    });
    const secondBody = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.aiError, null);
    assert.equal(secondBody.result.ai.enabled, true);
    assert.equal(secondBody.result.ai.provider, 'lmstudio');
    assert.equal(secondBody.result.ai.requestedProvider, 'f-aios-v3');
    assert.equal(secondBody.result.ai.fallback.from, 'f-aios-v3');
    assert.equal(secondBody.result.ai.fallback.to, 'lmstudio');
    assert.match(secondBody.result.ai.fallback.reason, /F-AIOS-v3 server error: 503/);
    const secondInsight = secondBody.result.messageInsights.find((item) => item.id === second.id);
    assert.equal(secondInsight.aiEnhanced, true);
    assert.equal(secondInsight.status, 'waiting');
    assert.equal(secondInsight.summary[0], 'LM Studio 폴백 분석 요약');
    assert.equal(faiosCalls, 3, 'F-AIOS should be attempted once initially and twice during retry/fallback run');
    assert.equal(lmStudioCalls, 1);
  } finally {
    await stopChild(app);
    await new Promise((resolve) => mockServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
