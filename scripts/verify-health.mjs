#!/usr/bin/env node
/**
 * Mail Intelligence health verification.
 * Default: syntax-only.
 * Full: start an isolated loopback server and verify the read-only boundary.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv.includes('--full') ? 'full' : 'syntax';
const configuredPort = String(process.env.PORT || process.env.MAIL_INTELLIGENCE_PORT || '').trim();
const host = String(process.env.MAIL_INTELLIGENCE_HOST || '127.0.0.1').trim().toLowerCase();
const syntaxFiles = [
  'server.mjs',
  'src/app.js',
  'src/analyzer.js',
  'src/ai-contract.js',
  'src/safety.js'
];

function baseUrlFor(port) {
  return host === '::1' ? `http://[::1]:${port}` : `http://${host}:${port}`;
}

async function freeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function runNodeCheck(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${file}: ${stderr.trim() || 'syntax check failed'}`));
    });
  });
}

async function probeStatus(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: controller.signal,
      cache: 'no-store'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function verifyStatusContract(body) {
  assert.equal(body.listenHost, host, 'server must report the requested loopback host');
  assert.equal(body.safety?.mode, 'read-only', 'server must run in read-only mode');
  assert.ok(
    Object.values(body.safety?.capabilities || {}).every((enabled) => enabled === false),
    'all mutation capabilities must be disabled'
  );
  assert.ok(body.graphConsent?.includes('Mail.Read'), 'Mail.Read scope is required');
  assert.ok(!body.graphConsent?.includes('Mail.Send'), 'Mail.Send scope must be absent');
  assert.ok(!body.graphConsent?.includes('Mail.ReadWrite'), 'Mail.ReadWrite scope must be absent');
  assert.equal(body.secretStorage, 'memory-or-environment-only');
  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'geminiApiKey']) {
    assert.equal(Object.hasOwn(body, key), false, `${key} must not be returned`);
  }
}

async function waitForStatus(baseUrl, server, serverLog) {
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      server.stdout.off('data', onData);
      server.off('close', onClose);
      server.off('error', onError);
    };
    const onData = () => {
      if (!serverLog().includes(`app running at ${baseUrl}`)) return;
      cleanup();
      resolve();
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`server exited before listening (${code})\n${serverLog()}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not become ready\n${serverLog()}`));
    }, 5000);
    server.stdout.on('data', onData);
    server.once('close', onClose);
    server.once('error', onError);
    onData();
  });
  return probeStatus(baseUrl);
}

async function stopServer(server) {
  if (server.exitCode != null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => server.kill('SIGKILL'), 1500);
    server.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    server.kill('SIGTERM');
  });
}

async function verifyDuplicateStart(env) {
  const duplicate = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  duplicate.stdout.on('data', (chunk) => { log += chunk.toString(); });
  duplicate.stderr.on('data', (chunk) => { log += chunk.toString(); });

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      duplicate.kill('SIGKILL');
      reject(new Error(`duplicate server did not exit promptly\n${log}`));
    }, 3000);
    duplicate.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    duplicate.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, `duplicate server must exit successfully\n${log}`);
  assert.match(log, /Mail Intelligence is already running at /);
}

async function runFullCheck() {
  const port = configuredPort ? Number(configuredPort) : await freeLoopbackPort();
  const baseUrl = baseUrlFor(port);
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-health-'));
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    MAIL_INTELLIGENCE_DATA_DIR: dataDir
  };
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk.toString(); });
  server.stderr.on('data', (chunk) => { log += chunk.toString(); });

  try {
    const body = await waitForStatus(baseUrl, server, () => log);
    verifyStatusContract(body);
    await verifyDuplicateStart(serverEnv);
    console.log(`[verify-health] OK ${baseUrl}/api/health`, {
      listenHost: body.listenHost,
      safetyMode: body.safety.mode,
      graphConsent: body.graphConsent,
      secretStorage: body.secretStorage,
      duplicateStart: 'detected'
    });
  } finally {
    await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  for (const file of syntaxFiles) {
    await runNodeCheck(file);
    console.log(`[verify-health] ${file} syntax OK`);
  }

  if (mode === 'syntax') {
    const previewPort = configuredPort ? Number(configuredPort) : 3010;
    console.log(`[verify-health] syntax-only PASS (use --full to probe an isolated loopback port; default preview ${baseUrlFor(previewPort)}/api/health)`);
    return;
  }

  console.log('[verify-health] full mode: isolated probe on an available loopback port');
  await runFullCheck();
}

main().catch((error) => {
  console.error('[verify-health] FAIL:', error?.stack || error?.message || error);
  process.exit(1);
});
