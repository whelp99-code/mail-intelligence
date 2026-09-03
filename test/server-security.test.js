import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${logs.join('')}`);
}

test('v1.2.2 server security boundary', async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-test-'));
  await writeFile(join(dataDir, '.outlook-config.json'), JSON.stringify({
    clientId: 'legacy-safe-client',
    accessToken: 'legacy-secret-token',
    refreshToken: 'legacy-refresh-token',
    expiresAt: 9999999999999,
  }), { mode: 0o600 });
  const logs = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_EXTERNAL_ACTIONS_ENABLED: '1',
      MAIL_INTELLIGENCE_SEND_ENABLED: '1',
      MAIL_INTELLIGENCE_MARK_READ_ENABLED: '1',
      MAIL_INTELLIGENCE_DATA_PLANE_ENABLED: '1',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
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
  assert.equal(health.ok, true);
  assert.equal(health.version, '1.2.2');
  assert.equal(health.storage.authoritativeStore, 'sqlite');
  assert.equal(health.storage.schemaVersion, 4);
  assert.equal(health.externalActionsAllowed, false);

  await t.test('root UI serves the read-only v1.2.2 operational-classification application', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const html = await response.text();
    assert.match(html, /v1\.2\.2 · Operational Classification/);
    assert.match(html, /초안은 복사만 가능하며 메일 발송·원본 변경·캘린더·CRM 자동 쓰기는 계속 차단/);
    assert.equal(html.includes('id="loadSample"'), false);
    assert.equal(html.includes('id="sendMail"'), false);
  });

  await t.test('static assets are served with security headers', async () => {
    const response = await fetch(`${baseUrl}/app.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /javascript/);
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
    const source = await response.text();
    assert.match(source, /async function apiFetch/);
    assert.equal(source.includes('/api/outlook/send'), false);
  });

  await t.test('non-GET static request is rejected', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST' });
    assert.equal(response.status, 405);
  });

  await t.test('sensitive API requires a browser session', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/status`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'SESSION_REQUIRED');
  });

  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const setCookie = sessionResponse.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.ok(session.csrfToken);
  assert.deepEqual(session.capabilities, { sendMail: false, markRead: false, dataPlane: false });

  await t.test('legacy plaintext secrets are removed during startup', async () => {
    const persistedText = await readFile(join(dataDir, '.outlook-config.json'), 'utf8');
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.clientId, 'legacy-safe-client');
    assert.equal('accessToken' in persisted, false);
    assert.equal('refreshToken' in persisted, false);
    assert.equal('expiresAt' in persisted, false);
    assert.equal(persistedText.includes('legacy-secret-token'), false);
  });

  await t.test('authenticated status is read-only and reports secret policy', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/status`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.externalActionsAllowed, false);
    assert.equal(body.secretsPersisted, false);
  });

  await t.test('OAuth authorization requests only read mail in v1.2.2', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/oauth/start?clientId=test-client&tenantId=common`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    const location = response.headers.get('location') || '';
    const scope = new URL(location).searchParams.get('scope') || '';
    assert.match(scope, /Mail\.Read/);
    assert.equal(scope.includes('Mail.Send'), false);
  });

  await t.test('invalid top query is rejected before any Graph call', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/analyze?top=not-a-number`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /between 1 and 50/);
  });

  await t.test('state change without CSRF is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CSRF_REQUIRED');
  });

  const mutationHeaders = {
    Cookie: cookie,
    'X-CSRF-Token': session.csrfToken,
    'Content-Type': 'application/json',
  };

  await t.test('cross-origin state change is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        Origin: 'http://attacker.invalid',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ORIGIN_REJECTED');
  });

  await t.test('non-JSON mutation is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': session.csrfToken,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    assert.equal(response.status, 415);
  });

  await t.test('oversized JSON mutation is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ clientId: 'x'.repeat(1_049_000) }),
    });
    assert.equal(response.status, 413);
  });

  await t.test('secret values remain in memory and are not persisted by default', async () => {
    const secret = 'test-secret-token-not-persisted';
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        accessToken: secret,
        clientId: 'safe-client-id',
        tenantId: 'safe-tenant-id',
        persist: true,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.hasAccessToken, true);
    assert.equal(body.secretsPersisted, false);

    const persistedText = await readFile(join(dataDir, '.outlook-config.json'), 'utf8');
    const persisted = JSON.parse(persistedText);
    assert.equal(persistedText.includes(secret), false);
    assert.equal('accessToken' in persisted, false);
    assert.equal(persisted.clientId, 'safe-client-id');
  });

  await t.test('external AI provider is rejected without explicit data-policy opt-in', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ aiProvider: 'openai-codex-oauth', persist: false }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /data policy|explicitly accepted/i);
  });

  await t.test('external AI provider can be selected only after explicit data-policy opt-in', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({
        aiProvider: 'openai-codex-oauth',
        aiDataPolicyAccepted: true,
        persist: false,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.aiProvider, 'openai-codex-oauth');
    assert.equal(body.aiOptedIn, true);

    const reset = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ aiProvider: 'rules', persist: false }),
    });
    assert.equal(reset.status, 200);
  });

  await t.test('legacy local AI URL fields are rejected instead of silently accepted', async () => {
    const response = await fetch(`${baseUrl}/api/outlook/config`, {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ faiosServerUrl: 'http://example.com:3201', persist: false }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'LEGACY_AI_PROVIDER_UNSUPPORTED');
    assert.match(body.message, /official OAuth CLI provider/i);
  });

  for (const [name, path, body] of [
    ['send', '/api/outlook/send', { to: 'person@example.com', subject: 'test', body: 'test' }],
    ['read', '/api/outlook/read', { messageId: 'message-1', isRead: true }],
    ['data-plane', '/api/hooks/data-plane', { message: { id: 'message-1' } }],
    ['fixture', '/api/fixtures/ingest-mail', { messageId: 'fixture-1' }],
  ]) {
    await t.test(`${name} external action remains disabled even when environment flags request it`, async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, 'EXTERNAL_ACTION_DISABLED');
    });
  }

  await t.test('static traversal does not expose repository files', async () => {
    const response = await fetch(`${baseUrl}/%2e%2e/package.json`);
    const body = await response.text();
    assert.equal(body.includes('standalone-mail-intelligence'), false);
    assert.match(response.headers.get('content-security-policy') || '', /default-src 'self'/);
  });
});
