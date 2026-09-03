import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let port;
let baseUrl;
const accessKey = 'integration-access-key-0123456789abcdef';
let server;
let output = '';
let dataDir;

async function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const selectedPort = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(selectedPort);
      });
    });
  });
}

async function stopServer() {
  if (!server || server.exitCode != null || server.signalCode != null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(2_000).then(() => false),
  ]);
  if (!graceful && server.exitCode == null && server.signalCode == null) {
    server.kill('SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Server did not become healthy. Output: ${output}`);
}

async function json(response) {
  return response.json().catch(() => ({}));
}

function basicAuthorization(key = accessKey) {
  return `Basic ${Buffer.from(`mailintelligence:${key}`, 'utf8').toString('base64')}`;
}

async function authenticatedCookie() {
  const response = await fetch(`${baseUrl}/`, {
    headers: { Authorization: basicAuthorization() }
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mi_session=/);
  return cookie;
}

test.before(async () => {
  port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-test-'));
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: accessKey,
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (chunk) => { output += chunk.toString(); });
  server.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitForHealth();
});

test.after(async () => {
  await stopServer();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('공개 health에는 비밀 설정을 노출하지 않는다', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.capabilities.send, false);
  assert.equal('tenantId' in body, false);
  assert.equal('clientId' in body, false);
});

test('OAuth 오류 설명은 HTML로 실행되지 않도록 이스케이프한다', async () => {
  const response = await fetch(`${baseUrl}/auth/callback?error_description=${encodeURIComponent('<script>alert(1)</script>')}`);
  const body = await response.text();

  assert.equal(response.status, 400);
  assert.doesNotMatch(body, /<script>/i);
  assert.match(body, /&lt;script&gt;/i);
});

test('업무 API는 브라우저 세션 없이 접근할 수 없다', async () => {
  const response = await fetch(`${baseUrl}/api/outlook/config`);
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.code, 'ACCESS_REQUIRED');
});

test('루트 화면은 접근키가 없으면 Basic 인증을 요구한다', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /Basic realm="Mail Intelligence"/);
});

test('올바른 접근키로만 HttpOnly SameSite 세션을 발급한다', async () => {
  const invalid = await fetch(`${baseUrl}/`, {
    headers: { Authorization: basicAuthorization('wrong-access-key') }
  });
  assert.equal(invalid.status, 401);

  const response = await fetch(`${baseUrl}/`, {
    headers: { Authorization: basicAuthorization() }
  });
  const cookie = response.headers.get('set-cookie') || '';

  assert.equal(response.status, 200);
  assert.match(cookie, /mi_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('세션과 mutation header가 있어도 외부 행동 Kill Switch가 우선 차단한다', async () => {
  const cookie = await authenticatedCookie();
  const headers = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-Mail-Intelligence-Request': '1'
  };

  for (const [pathname, payload] of [
    ['/api/outlook/send', { to: 'recipient@example.com', subject: 'test', body: 'test' }],
    ['/api/outlook/read', { messageId: 'demo-1', isRead: true }],
    ['/api/hooks/data-plane', { messageId: 'demo-1', subject: 'test' }]
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    const body = await json(response);
    assert.equal(response.status, 403, `${pathname}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'EXTERNAL_ACTION_DISABLED');
  }
});

test('레거시 로컬 AI provider 설정은 명시적으로 거부한다', async () => {
  const cookie = await authenticatedCookie();
  const response = await fetch(`${baseUrl}/api/outlook/config`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Mail-Intelligence-Request': '1'
    },
    body: JSON.stringify({
      aiProvider: 'rules',
      faiosServerUrl: 'http://example.com:3201',
      domainProfile: 'generic',
      persist: false
    })
  });
  const body = await json(response);

  assert.equal(response.status, 400);
  assert.equal(body.code, 'LEGACY_AI_PROVIDER_UNSUPPORTED');
});

test('민감 설정은 공개 설정 JSON에 평문으로 저장하지 않는다', async () => {
  const cookie = await authenticatedCookie();
  const sentinels = {
    accessToken: 'plain-access-token-sentinel',
    clientSecret: 'plain-client-secret-sentinel'
  };
  const response = await fetch(`${baseUrl}/api/outlook/config`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Mail-Intelligence-Request': '1'
    },
    body: JSON.stringify({
      ...sentinels,
      tenantId: 'tenant-test',
      clientId: 'client-test',
      aiProvider: 'rules',
      domainProfile: 'generic',
      persist: true
    })
  });
  assert.equal(response.status, 200, JSON.stringify(await json(response)));

  const publicConfig = await readFile(join(dataDir, '.outlook-config.json'), 'utf8');
  const encryptedSecrets = await readFile(join(dataDir, '.outlook-secrets.enc.json'), 'utf8');
  for (const value of Object.values(sentinels)) {
    assert.doesNotMatch(publicConfig, new RegExp(value));
    assert.doesNotMatch(encryptedSecrets, new RegExp(value));
  }
  assert.doesNotMatch(publicConfig, /accessToken|clientSecret|geminiApiKey|refreshToken/);
  assert.match(encryptedSecrets, /aes-256-gcm/);
});

test('mutation header가 없으면 외부 행동 함수에 도달하기 전에 차단한다', async () => {
  const cookie = await authenticatedCookie();
  const response = await fetch(`${baseUrl}/api/outlook/send`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'recipient@example.com', subject: 'test', body: 'test' })
  });
  const body = await json(response);

  assert.equal(response.status, 403);
  assert.equal(body.code, 'MUTATION_PROTECTION_REQUIRED');
});

test('메일 선택 함수에는 자동 읽음 호출이 없다', async () => {
  const source = await readFile('src/app.js', 'utf8');
  const selectMessage = source.match(/function selectMessage\(messageId\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(selectMessage, /markMessageRead\(messageId\)/);
});
