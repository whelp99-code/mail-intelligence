import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const accessKey = '[REDACTED]';

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
    delay(1_000),
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
    toRecipients: [],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: receivedAt,
    importance: 'normal',
    isRead: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
  };
}

function aiPayload(message) {
  return {
    messages: [{
      id: message.id,
      status: 'urgent',
      confidence: 0.98,
      summary: ['Codex OAuth 정상 분석 요약'],
      nextActions: [{
        actionType: 'draft_reply',
        title: '진행 일정 회신',
        recommendedAction: '오늘 중 고객에게 진행 일정을 회신',
        owner: '박재민',
        due: '오늘',
        priority: 1,
        lane: 'urgent',
        evidence: message.bodyPreview,
        intent: '메일의 명시적 요청에 대응',
        to: 'customer@example.com',
        subject: `RE: ${message.subject}`,
        body: '검증된 OAuth AI 회신 초안',
      }],
      evidenceItems: [message.bodyPreview],
      aiRationale: '메일 본문의 요청을 근거로 판단',
    }],
  };
}

async function fakeCodexCli(directory, firstMessage) {
  const path = join(directory, 'codex');
  const source = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli test-oauth');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
const outputIndex = args.indexOf('--output-last-message');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.includes('ai-mail-2')) {
    console.error('synthetic codex oauth failure');
    process.exit(17);
    return;
  }
  fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(JSON.stringify(aiPayload(firstMessage)))});
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'oauth-test' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
});
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test('실제 API 경로에서 Codex ChatGPT OAuth 분석과 실패 시 Rules 폴백이 투명하다', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-ai-enrichment-'));
  const cliDir = await mkdtemp(join(tmpdir(), 'mi-oauth-cli-'));
  const first = graphMessage({
    id: 'ai-mail-1',
    changeKey: 'v1',
    subject: '오늘 중 일정 회신 요청',
    receivedAt: '2026-08-28T01:00:00.000Z',
    body: '오늘 중으로 진행 일정을 회신 부탁드립니다.',
  });
  const second = graphMessage({
    id: 'ai-mail-2',
    changeKey: 'v1',
    subject: '승인 상태 확인 요청',
    receivedAt: '2026-08-28T02:00:00.000Z',
    body: '내부 승인 상태를 확인한 뒤 알려주세요.',
  });
  const codexCli = await fakeCodexCli(cliDir, first);
  let graphMessages = [first];

  let mockBaseUrl = '';
  const mockServer = createServer((req, res) => {
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
          unreadItemCount: graphMessages.length,
          isHidden: false,
        }],
      });
      return;
    }
    if (url.pathname === '/v1.0/me/mailFolders/inbox/messages/delta') {
      jsonResponse(res, 200, {
        value: graphMessages,
        '@odata.deltaLink': `${mockBaseUrl}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=current`,
      });
      return;
    }
    jsonResponse(res, 404, { message: 'mock route not found' });
  });

  const mockPort = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  const appPort = await freePort();
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  await writeFile(join(dataDir, '.outlook-config.json'), JSON.stringify({
    tenantId: '',
    clientId: '',
    mailboxUser: '',
    loginTenant: 'common',
    aiProvider: 'openai-codex-oauth',
    openaiCodexModel: 'luna',
    xaiGrokModel: 'grok-4.6',
    aiOptInVersion: 'ai-oauth-opt-in-v1.2.2',
    domainProfile: 'generic',
    domainProfiles: '',
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
      MAIL_INTELLIGENCE_CODEX_BIN: codexCli,
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => output.push(chunk.toString()));
  app.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(appBaseUrl, output);
    const root = await fetch(`${appBaseUrl}/`, { headers: { Authorization: basicAuthorization() } });
    assert.equal(root.status, 200);
    const cookie = (root.headers.get('set-cookie') || '').split(';')[0];

    const firstResponse = await fetch(`${appBaseUrl}/api/outlook/analyze?top=1`, { headers: { Cookie: cookie } });
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(firstBody));
    assert.equal(firstBody.aiError, null);
    assert.equal(firstBody.result.ai.enabled, true);
    assert.equal(firstBody.result.ai.provider, 'openai-codex-oauth');
    assert.equal(firstBody.result.ai.requestedProvider, 'openai-codex-oauth');
    assert.equal(firstBody.result.ai.fallback, null);
    assert.match(firstBody.result.ai.policyVersion, /^mail-intelligence-v1\.2\.2-oauth-prompt-/);
    const firstInsight = firstBody.result.messageInsights.find((item) => item.id === first.id);
    assert.equal(firstInsight.aiEnhanced, true);
    assert.equal(firstInsight.summary[0], 'Codex OAuth 정상 분석 요약');

    graphMessages = [second];
    const secondResponse = await fetch(`${appBaseUrl}/api/outlook/analyze?top=1`, { headers: { Cookie: cookie } });
    const secondBody = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(secondBody));
    assert.equal(secondBody.result.ai.enabled, false);
    assert.equal(secondBody.result.ai.status, 'failed');
    assert.equal(secondBody.result.ai.provider, 'openai-codex-oauth');
    assert.match(secondBody.aiError || '', /실제 모델 호출을 완료하지 못했습니다/);
    assert.doesNotMatch(secondBody.aiError || '', /synthetic codex oauth failure/i);
    assert.equal(secondBody.result.ai.fallbackFrom, null);
    const secondInsight = secondBody.result.messageInsights.find((item) => item.id === second.id);
    assert.equal(secondInsight.aiEnhanced, false);
    assert.equal(secondInsight.analysisState, 'degraded');
  } finally {
    await stopChild(app);
    await new Promise((resolve) => mockServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(cliDir, { recursive: true, force: true });
  }
});

test('external AI policy OFF returns policy_blocked with Rules results and no provider error', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-ai-policy-blocked-'));
  const mail = graphMessage({
    id: 'policy-mail-1',
    changeKey: 'v1',
    subject: '견적 확인 요청',
    receivedAt: '2026-08-31T01:00:00.000Z',
    body: '첨부 견적서를 확인 부탁드립니다.',
  });

  let mockBaseUrl = '';
  const mockServer = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/v1.0/me/mailFolders') {
      jsonResponse(res, 200, {
        value: [{
          id: 'inbox',
          displayName: 'Inbox',
          parentFolderId: '',
          childFolderCount: 0,
          totalItemCount: 1,
          unreadItemCount: 1,
          isHidden: false,
        }],
      });
      return;
    }
    if (url.pathname === '/v1.0/me/mailFolders/inbox/messages/delta') {
      jsonResponse(res, 200, {
        value: [mail],
        '@odata.deltaLink': `${mockBaseUrl}/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=current`,
      });
      return;
    }
    jsonResponse(res, 404, { message: 'mock route not found' });
  });

  const mockPort = await listen(mockServer);
  mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  const appPort = await freePort();
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  await writeFile(join(dataDir, '.outlook-config.json'), JSON.stringify({
    tenantId: '',
    clientId: '',
    mailboxUser: '',
    loginTenant: 'common',
    aiProvider: 'openai-codex-oauth',
    openaiCodexModel: 'luna',
    xaiGrokModel: 'grok-4.6',
    aiOptInVersion: 'ai-oauth-opt-in-v1.2.2',
    domainProfile: 'generic',
    domainProfiles: '',
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
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (chunk) => output.push(chunk.toString()));
  app.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    await waitForHealth(appBaseUrl, output);
    const root = await fetch(`${appBaseUrl}/`, { headers: { Authorization: basicAuthorization() } });
    assert.equal(root.status, 200);
    const cookie = (root.headers.get('set-cookie') || '').split(';')[0];
    const response = await fetch(`${appBaseUrl}/api/outlook/analyze?top=1`, { headers: { Cookie: cookie } });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.aiError, null);
    assert.equal(body.result.ai.status, 'policy_blocked');
    assert.equal(body.result.ai.code, 'EXTERNAL_AI_DISABLED');
    assert.equal(body.result.ai.fallback, 'rules');
    assert.equal(body.result.ai.rulesUsed, true);
    assert.equal(body.result.ai.error, null);
    assert.match(body.result.ai.message, /Rules 결과/);
    assert.match(body.result.ai.userAction, /운영자 승인/);
    const insight = body.result.messageInsights.find((item) => item.id === mail.id);
    assert.equal(insight.aiEnhanced, false);
    assert.equal(insight.analysisState, 'policy_blocked');
  } finally {
    await stopChild(app);
    await new Promise((resolve) => mockServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
