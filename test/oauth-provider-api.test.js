import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const accessKey = '[REDACTED]';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fakeCli(directory, name, source) {
  const path = join(directory, name);
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // App is still starting.
    }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${logs.join('')}`);
}

function validSyntheticAnalysis() {
  return JSON.stringify({
    messages: [{
      id: 'oauth-test-message',
      status: 'reference',
      confidence: 0.99,
      summary: ['OAuth 연결 테스트'],
      nextActions: [],
      evidenceItems: ['OAuth provider connection test. No real email content is included.'],
      aiRationale: '합성 입력을 근거로 연결 상태를 검증',
    }],
  });
}

test('OAuth provider APIs expose safe status, instructions and synthetic connection tests', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-api-'));
  const cliDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-oauth-cli-'));
  const analysis = validSyntheticAnalysis();
  const codex = await fakeCli(cliDir, 'codex', `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli oauth-api-test');
else if (args[0] === 'login' && args[1] === 'status') console.log('Logged in using ChatGPT');
else {
  const outputIndex = args.indexOf('--output-last-message');
  process.stdin.resume();
  process.stdin.on('end', () => {
    fs.writeFileSync(args[outputIndex + 1], ${JSON.stringify(analysis)});
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
  });
}
`);
  const grok = await fakeCli(cliDir, 'grok', `
const args = process.argv.slice(2);
if (args[0] === 'version') console.log('grok oauth-api-test');
else if (args[0] === 'models') console.log('grok-4.6');
else {
  console.error('API error (status 402 Payment Required): usage balance exhausted');
  process.exit(1);
}
`);
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
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '1',
      MAIL_INTELLIGENCE_CODEX_BIN: codex,
      MAIL_INTELLIGENCE_GROK_BIN: grok,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await delay(100);
    await rm(dataDir, { recursive: true, force: true });
    await rm(cliDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, logs);
  let response = await fetch(`${baseUrl}/api/ai/oauth/status`);
  assert.equal(response.status, 401);

  const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}`;
  response = await fetch(`${baseUrl}/`, { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  response = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const session = await response.json();
  const mutationHeaders = {
    Cookie: cookie,
    Origin: baseUrl,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
    'X-Mail-Intelligence-Request': '1',
  };

  response = await fetch(`${baseUrl}/api/ai/oauth/status`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  let body = await response.json();
  assert.equal(body.externalAiEnabled, true);
  assert.equal(body.providers.length, 2);
  assert.ok(body.providers.every((provider) => provider.installed && provider.authenticated));
  assert.equal(JSON.stringify(body).includes('access_token'), false);

  response = await fetch(`${baseUrl}/api/ai/oauth/instructions?provider=openai-codex-oauth`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  body = await response.json();
  assert.equal(body.command, 'codex login --device-auth');
  assert.equal(JSON.stringify(body).includes('token'), false);

  response = await fetch(`${baseUrl}/api/outlook/config`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({
      aiProvider: 'openai-codex-oauth',
      aiDataPolicyAccepted: true,
      openaiCodexModel: 'luna',
      xaiGrokModel: 'grok-4.6',
      persist: false,
    }),
  });
  body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  response = await fetch(`${baseUrl}/api/ai/oauth/test`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ provider: 'openai-codex-oauth', model: '' }),
  });
  body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.evidenceVerified, true);
  assert.equal(body.provider, 'openai-codex-oauth');
  assert.equal(body.status, 'passed');
  assert.ok(body.latencyMs >= 0);

  response = await fetch(`${baseUrl}/api/ai/oauth/test`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ provider: 'xai-grok-oauth', model: 'grok-4.6' }),
  });
  body = await response.json();
  assert.equal(response.status, 424, JSON.stringify(body));
  assert.equal(body.ok, false);
  assert.equal(body.safeErrorCode, 'BILLING_BALANCE_EXHAUSTED');
  assert.match(body.message, /잔액/);
  assert.match(body.userAction, /결제|잔액/);
  assert.doesNotMatch(JSON.stringify(body), /usage balance exhausted|Payment Required|Internal error/);

  response = await fetch(`${baseUrl}/api/ai/oauth/status`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  body = await response.json();
  const openai = body.providers.find((provider) => provider.provider === 'openai-codex-oauth');
  const xai = body.providers.find((provider) => provider.provider === 'xai-grok-oauth');
  assert.equal(openai.cliInstalled, true);
  assert.equal(openai.oauthAuthenticated, true);
  assert.equal(openai.lastSyntheticTest.status, 'passed');
  assert.equal(openai.operationalStatus, 'available');
  assert.equal(xai.cliInstalled, true);
  assert.equal(xai.oauthAuthenticated, true);
  assert.equal(xai.lastSyntheticTest.status, 'failed');
  assert.equal(xai.lastSyntheticTest.safeErrorCode, 'BILLING_BALANCE_EXHAUSTED');
  assert.equal(xai.operationalStatus, 'unavailable');
});
