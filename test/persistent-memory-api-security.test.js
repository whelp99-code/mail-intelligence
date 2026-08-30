import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? rejectPromise(error) : resolvePromise(port));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.storage?.ready === true) return body;
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error(`server did not become healthy: ${logs.join('')}`);
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

test('persistent-memory management APIs fail closed against unauthorized and malformed requests', async (t) => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-memory-security-'));
  const logs = [];
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
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
  assert.equal(health.storage.authoritativeStore, 'sqlite');
  assert.equal(JSON.stringify(health).includes(dataDir), false);

  await t.test('storage status requires a session', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/storage/status');
    assert.equal(response.status, 401);
    assert.equal(body.code, 'SESSION_REQUIRED');
  });

  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = (sessionResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mi_session=/);
  assert.ok(session.csrfToken);

  await t.test('protected storage status omits filesystem paths and raw Graph cursors', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/storage/status', {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(body.authoritativeStore, 'sqlite');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(dataDir), false);
    assert.equal(serialized.includes('@odata.nextLink'), false);
    assert.equal(serialized.includes('@odata.deltaLink'), false);
    assert.equal(serialized.toLowerCase().includes('deltatoken='), false);
  });

  await t.test('backup without CSRF is rejected before creating a file', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/storage/backup', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(body.code, 'CSRF_REQUIRED');
  });

  const mutationHeaders = {
    Cookie: cookie,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.csrfToken,
  };

  await t.test('cross-origin backup is rejected', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/storage/backup', {
      method: 'POST',
      headers: {
        ...mutationHeaders,
        Origin: 'http://attacker.invalid',
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(body.code, 'ORIGIN_REJECTED');
  });

  await t.test('invalid sync bounds are rejected before Graph access', async () => {
    let result = await jsonRequest(baseUrl, '/api/outlook/sync', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ top: 0, forceInitial: false }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'TOP_INVALID');

    result = await jsonRequest(baseUrl, '/api/outlook/sync', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ top: 1, forceInitial: 'yes' }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'FORCE_INITIAL_INVALID');
  });

  await t.test('search query and limit are bounded', async () => {
    let result = await jsonRequest(baseUrl, '/api/mail/search?limit=25', {
      headers: { Cookie: cookie },
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'SEARCH_QUERY_REQUIRED');

    result = await jsonRequest(baseUrl, '/api/mail/search?q=test&limit=101', {
      headers: { Cookie: cookie },
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, 'SEARCH_LIMIT_INVALID');
  });

  await t.test('database restore is not exposed through HTTP', async () => {
    const { response, body } = await jsonRequest(baseUrl, '/api/storage/restore', {
      method: 'POST',
      headers: mutationHeaders,
      body: JSON.stringify({ backup: 'untrusted.sqlite' }),
    });
    assert.equal(response.status, 404);
    assert.equal(body.code, 'NOT_FOUND');
  });
});
