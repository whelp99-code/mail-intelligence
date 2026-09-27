import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Starts the existing product entrypoint with fresh storage and no inherited credentials.
// It does not replace the product API or UI with a fixture implementation.
export async function startIsolatedProductServer(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'core5-product-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const operatorKey = options.operatorKey || randomBytes(32).toString('hex');
  const botKey = options.botKey || randomBytes(32).toString('hex');
  let child;
  let logs = '';
  const env = {
    PATH: process.env.PATH || '',
    PORT: String(port), MAIL_INTELLIGENCE_HOST: '127.0.0.1',
    MAIL_INTELLIGENCE_DATA_DIR: directory,
    MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
    MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: botKey,
    MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE: '',
    MAIL_INTELLIGENCE_ALLOW_SEND: '0',
    MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
    MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
    MAIL_INTELLIGENCE_GRAPH_BASE_URL: 'http://127.0.0.1:1/disabled',
    OUTLOOK_GRAPH_ACCESS_TOKEN: 'synthetic-token-without-send-scope',
  };
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await done; } finally { clearTimeout(timer); }
  }
  async function start() {
    child = spawn(process.execPath, [join(root, 'server.mjs')], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-16000); });
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Isolated product exited: ${child.exitCode}`);
      try {
        const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) });
        await response.arrayBuffer();
        if (response.ok) return;
      } catch { /* Bounded startup race, not a test pass. */ }
      await delay(50);
    }
    throw new Error('Isolated product did not become healthy');
  }
  async function login() {
    const response = await fetch(base + '/', {
      headers: { Authorization: 'Basic ' + Buffer.from('mailintelligence:' + operatorKey).toString('base64') },
      signal: AbortSignal.timeout(3000),
    });
    await response.arrayBuffer();
    if (!response.ok || !response.headers.get('set-cookie')) throw new Error('Product login failed');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const sessionResponse = await fetch(base + '/api/session', { headers: { Cookie: cookie } });
    if (!sessionResponse.ok) throw new Error('Product session failed');
    const session = await sessionResponse.json();
    return { cookie, session, human: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken } };
  }
  try { await start(); } catch (error) { await stop(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    base, directory, login,
    bot: { Authorization: 'Bearer ' + botKey, 'Content-Type': 'application/json' },
    restart: async () => { await stop(); await start(); },
    close: async () => { await stop(); await rm(directory, { recursive: true, force: true }); },
    secretsLeaked: () => logs.includes(operatorKey) || logs.includes(botKey),
  };
}
