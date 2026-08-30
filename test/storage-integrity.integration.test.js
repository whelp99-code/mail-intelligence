import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const accessKey = 'storage-integrity-access-key-0123456789';
let portOffset = 0;

function nextPort() {
  portOffset += 1;
  return 36_000 + (process.pid % 1_000) + portOffset;
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
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  return { child, output };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(1_000)
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForExit(child, timeoutMs = 5_000) {
  const result = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, timedOut: false }));
    }),
    delay(timeoutMs).then(() => ({ code: child.exitCode, signal: null, timedOut: true }))
  ]);
  if (result.timedOut) await stopServer(child);
  return result;
}

test('손상된 공개 설정은 기동을 중단하고 원본 파일을 보존한다', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-public-config-corrupt-'));
  const configPath = join(dataDir, '.outlook-config.json');
  const original = '{ invalid public config';
  await writeFile(configPath, original, 'utf8');
  const { child, output } = startServer(dataDir, nextPort());

  try {
    const exit = await waitForExit(child);
    assert.equal(exit.timedOut, false, output.join(''));
    assert.notEqual(exit.code, 0, output.join(''));
    assert.match(output.join(''), /public configuration is unreadable or invalid/i);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('손상된 암호화 비밀 파일은 기동을 중단하고 원본 파일을 보존한다', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-secret-corrupt-'));
  const secretPath = join(dataDir, '.outlook-secrets.enc.json');
  const original = '{ invalid encrypted envelope';
  await writeFile(secretPath, original, 'utf8');
  const { child, output } = startServer(dataDir, nextPort());

  try {
    const exit = await waitForExit(child);
    assert.equal(exit.timedOut, false, output.join(''));
    assert.notEqual(exit.code, 0, output.join(''));
    assert.match(output.join(''), /encrypted secrets are unreadable or invalid/i);
    assert.equal(await readFile(secretPath, 'utf8'), original);
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('손상된 레거시 메일 캐시는 SQLite 이관을 중단하고 원본을 보존한다', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mi-cache-corrupt-'));
  const cachePath = join(dataDir, '.mail-cache.json');
  const original = '{ invalid mail cache';
  await writeFile(cachePath, original, 'utf8');
  const { child, output } = startServer(dataDir, nextPort());

  try {
    const exit = await waitForExit(child);
    assert.equal(exit.timedOut, false, output.join(''));
    assert.notEqual(exit.code, 0, output.join(''));
    assert.match(output.join(''), /Legacy mail cache is not valid JSON/i);
    assert.match(output.join(''), /LEGACY_CACHE_INVALID/);
    assert.equal(await readFile(cachePath, 'utf8'), original);
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
});
