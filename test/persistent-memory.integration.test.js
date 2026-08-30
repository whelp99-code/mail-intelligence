import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const accessKey = '[REDACTED]';

async function freePort() {
  const probe = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

function basicAuthorization() {
  return `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
}

function startServer(dataDir, port) {
  const output = [];
  const child = spawn(process.execPath, ['server.mjs'], {
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
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  return { child, output };
}

async function waitForHealth(baseUrl, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.storage?.ready === true) return body;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }
  throw new Error(`Server did not become healthy. Output: ${output.join('')}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolvePromise) => child.once('exit', resolvePromise)),
    delay(2_000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }),
  ]);
}

async function sessionCookie(baseUrl) {
  const response = await fetch(`${baseUrl}/`, {
    headers: { Authorization: basicAuthorization() },
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^mi_session=/);
  return cookie;
}

async function apiJson(baseUrl, pathname, { cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-Mail-Intelligence-Request'] = '1';
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

test('SQLite remains authoritative across restart for mail, feedback, FTS, jobs and verified backup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-persistent-runtime-'));
  const legacyPath = join(dataDir, '.mail-cache.json');
  const legacyContents = JSON.stringify({
    version: 1,
    mailboxes: {
      me: {
        messages: [{
          id: 'persistent-message-1',
          changeKey: 'legacy-change-1',
          conversationId: 'persistent-thread-1',
          subject: '선진 프로젝트 일정 확인',
          from: 'owner@example.com',
          fromName: 'Owner',
          cc: [],
          receivedAt: '2026-08-28T01:00:00.000Z',
          importance: 'normal',
          isRead: false,
          bodyPreview: '선진 프로젝트 장비 일정 확인 부탁드립니다.',
          body: '선진 프로젝트 장비 일정 확인 부탁드립니다.',
          webLink: 'https://outlook.office.com/mail/persistent-message-1',
        }],
        feedback: {},
        analysis: {},
      },
    },
  }, null, 2);
  await writeFile(legacyPath, legacyContents, { mode: 0o600 });

  let running;
  try {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    running = startServer(dataDir, port);
    const health = await waitForHealth(baseUrl, running.output);
    assert.equal(health.storage.authoritativeStore, 'sqlite');
    assert.equal(health.storage.schemaVersion, 4);

    let cookie = await sessionCookie(baseUrl);
    let result = await apiJson(baseUrl, '/api/storage/status', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.counts.messages, 1);
    assert.equal(result.payload.legacyImports[0].imported, true);

    result = await apiJson(baseUrl, '/api/outlook/messages?top=10', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.mode, 'offline-cache');
    assert.equal(result.payload.messages[0].id, 'persistent-message-1');

    result = await apiJson(baseUrl, `/api/mail/search?q=${encodeURIComponent('선진 프로젝트')}&limit=10`, { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.results.length, 1);
    assert.equal(result.payload.results[0].id, 'persistent-message-1');

    result = await apiJson(baseUrl, '/api/outlook/feedback', {
      cookie,
      method: 'POST',
      body: {
        messageId: 'persistent-message-1',
        userStatus: 'waiting',
        reasonCode: 'waiting',
        note: '고객 일정 회신 대기',
      },
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.feedback.userStatus, 'waiting');

    result = await apiJson(baseUrl, '/api/storage/backup', {
      cookie,
      method: 'POST',
      body: {},
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.payload));
    assert.equal(result.payload.backup.integrity, true);
    assert.match(result.payload.backup.checksumSha256, /^[a-f0-9]{64}$/);
    await access(join(dataDir, 'backups', result.payload.backup.name));

    await stopServer(running.child);
    running = null;

    const restartPort = await freePort();
    const restartBaseUrl = `http://127.0.0.1:${restartPort}`;
    running = startServer(dataDir, restartPort);
    await waitForHealth(restartBaseUrl, running.output);
    cookie = await sessionCookie(restartBaseUrl);

    result = await apiJson(restartBaseUrl, '/api/storage/status', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    assert.equal(result.payload.counts.messages, 1);
    assert.equal(result.payload.counts.message_feedback, 1);
    assert.equal(result.payload.counts.backup_manifests, 1);
    assert.equal(result.payload.counts.operator_jobs, 1);
    assert.equal(result.payload.legacyImports[0].skipped, true);
    assert.equal(result.payload.backups.length, 1);
    assert.equal(result.payload.jobs[0].status, 'completed');

    result = await apiJson(restartBaseUrl, '/api/outlook/analyze?top=10', { cookie });
    assert.equal(result.response.status, 200, JSON.stringify(result.payload));
    const insight = result.payload.result.messageInsights.find((item) => item.id === 'persistent-message-1');
    assert.equal(insight.effectiveStatus, 'waiting');
    assert.equal(insight.userFeedback.note, '고객 일정 회신 대기');
    assert.equal(await readFile(legacyPath, 'utf8'), legacyContents);
  } finally {
    await stopServer(running?.child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
