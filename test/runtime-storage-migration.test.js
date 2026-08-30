import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, log) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'unknown'}\n${log()}`);
}

async function stopServer(server) {
  if (server.exitCode != null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    delay(2000).then(() => {
      if (server.exitCode == null) server.kill('SIGKILL');
    }),
  ]);
}

async function expectAbsent(path) {
  await assert.rejects(access(path), (error) => error?.code === 'ENOENT');
}

test('legacy root JSON state migrates into private data storage without persisted secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-runtime-migration-'));
  const legacyDir = join(root, 'legacy');
  const dataDir = join(root, 'data');
  await mkdir(legacyDir, { recursive: true, mode: 0o700 });

  const legacyConfigPath = join(legacyDir, '.outlook-config.json');
  const legacyCachePath = join(legacyDir, '.mail-cache.json');
  await writeFile(legacyConfigPath, JSON.stringify({
    tenantId: 'common',
    clientId: '11111111-1111-4111-8111-111111111111',
    mailboxUser: 'owner@example.com',
    loginTenant: 'common',
    aiProvider: 'f-aios-v3',
    faiosServerUrl: 'http://localhost:3201',
    lmstudioModel: 'qwen/qwen3.5-9b',
    accessToken: 'legacy-access-token-value',
    refreshToken: 'legacy-refresh-token-value',
    clientSecret: 'legacy-client-secret-value',
    geminiApiKey: 'legacy-gemini-key-value',
    expiresAt: Date.now() + 60_000,
  }, null, 2), { mode: 0o600 });
  const legacyCacheContents = JSON.stringify({
    version: 1,
    mailboxes: {
      me: {
        messages: [{ id: 'legacy-message', subject: '기존 프로젝트 메일' }],
        feedback: {
          'legacy-message': { messageId: 'legacy-message', userStatus: 'active' },
        },
      },
    },
  }, null, 2);
  await writeFile(legacyCachePath, legacyCacheContents, { mode: 0o600 });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_LEGACY_DATA_DIR: legacyDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk.toString(); });
  server.stderr.on('data', (chunk) => { log += chunk.toString(); });

  t.after(async () => {
    await stopServer(server);
    await rm(root, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, () => log);
  assert.equal(health.ok, true);
  assert.equal(health.storage.authoritativeStore, 'sqlite');
  assert.equal(health.storage.schemaVersion, 4);

  const newConfigPath = join(dataDir, '.outlook-config.json');
  const databasePath = join(dataDir, 'mail-intelligence.sqlite');
  const migratedConfig = JSON.parse(await readFile(newConfigPath, 'utf8'));

  assert.equal(migratedConfig.tenantId, 'common');
  assert.equal(migratedConfig.clientId, '11111111-1111-4111-8111-111111111111');
  assert.equal(migratedConfig.mailboxUser, 'owner@example.com');
  assert.equal(migratedConfig.aiProvider, 'rules');
  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'geminiApiKey', 'expiresAt']) {
    assert.equal(Object.hasOwn(migratedConfig, key), false, `${key} must not persist after migration`);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const migratedMessage = database.prepare(`
      SELECT m.graph_id, m.subject, f.user_status
      FROM messages m
      LEFT JOIN message_feedback f ON f.message_id = m.id
      WHERE m.graph_id = ?
    `).get('legacy-message');
    assert.equal(migratedMessage.graph_id, 'legacy-message');
    assert.equal(migratedMessage.subject, '기존 프로젝트 메일');
    assert.equal(migratedMessage.user_status, 'active');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM legacy_imports').get().count, 1);
  } finally {
    database.close();
  }

  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(newConfigPath)).mode & 0o777, 0o600);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  await expectAbsent(legacyConfigPath);
  await expectAbsent(join(dataDir, '.mail-cache.json'));
  assert.equal(await readFile(legacyCachePath, 'utf8'), legacyCacheContents);
  assert.match(log, /Migrated legacy configuration/);
  assert.match(log, /SQLite schema v4 ready/);
});

test('server refuses an existing runtime data directory that is not owner-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-intelligence-unsafe-runtime-'));
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true, mode: 0o755 });
  await chmod(dataDir, 0o755);
  const port = await freePort();
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk.toString(); });
  server.stderr.on('data', (chunk) => { log += chunk.toString(); });
  try {
    const exitCode = await Promise.race([
      new Promise((resolve) => server.once('close', resolve)),
      delay(3000).then(() => {
        server.kill('SIGKILL');
        throw new Error(`server did not reject unsafe data directory promptly\n${log}`);
      }),
    ]);
    assert.notEqual(exitCode, 0);
    assert.match(log, /must be owner-only/);
  } finally {
    if (server.exitCode == null) server.kill('SIGKILL');
    await chmod(dataDir, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
