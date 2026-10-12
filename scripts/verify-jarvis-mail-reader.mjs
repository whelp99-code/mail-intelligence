import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Fixed, public fixture material only. Never issue or inspect an operational key.
const readerKey = 'synthetic-jarvis-reader-fixture-not-a-real-key';
const operatorKey = 'synthetic-human-operator-fixture-not-a-real-key';
const draftKey = 'synthetic-draft-fixture-not-a-real-key';
const principal = 'jarvis-fixture-reader';
const readerHeaders = {
  'x-api-key': readerKey, 'x-principal-id': principal,
  'x-principal-kind': 'service', Accept: 'application/json',
};

async function listen(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function databaseDigest(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name').all();
    const rows = tables.map(({ name }) => [name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .map(row => JSON.stringify(row)).sort(),
    ]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  } finally {
    db.close();
  }
}

async function startFixture({ seeded, enabled }) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-reader-http-'));
  let child;
  let logs = '';
  let providerHits = 0;
  const provider = createServer((_req, res) => {
    providerHits += 1;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"code":"FIXTURE_PROVIDER_DISABLED"}');
  });
  async function close() {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
        child.kill('SIGTERM');
        try { await exited; } catch (error) {
          if (child.exitCode === null && child.signalCode === null) {
            const killed = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
            child.kill('SIGKILL');
            await killed;
          }
          throw error;
        }
      }
    } finally {
      await closeServer(provider);
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    const providerUrl = await listen(provider);
    const portProbe = createServer();
    const base = await listen(portProbe);
    await closeServer(portProbe);
    const databasePath = join(directory, 'mail-intelligence.sqlite');
    const store = new SQLiteMailStore({ databasePath, migrationsDir: join(root, 'migrations') });
    try {
      if (seeded) {
        const mailbox = store.ensureMailbox({ key: 'me' });
        const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
        store.applyDeltaPage({
          mailboxId: mailbox.id, folderId: folder.id,
          syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }),
          pageIndex: 0,
          items: ['fixture-mail-1', 'fixture-mail-2'].map(id => normalizeGraphMessage({
            id, changeKey: 'fixture-revision', conversationId: 'fixture-thread',
            subject: 'Synthetic fixture summary', receivedDateTime: '2026-10-12T00:00:00Z',
            from: { emailAddress: { address: 'sender@example.invalid' } },
            body: { contentType: 'text', content: 'Synthetic stored mail, not production.' },
          })),
          deltaLink: `${providerUrl}/fixture-delta`,
        });
      }
    } finally { store.close(); }
    const keyFile = join(directory, 'reader.key');
    await writeFile(keyFile, readerKey, { mode: 0o600 });
    child = spawn(process.execPath, [join(root, 'server.mjs')], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: directory,
        PORT: new URL(base).port, HOST: '127.0.0.1',
        MAIL_INTELLIGENCE_DATA_DIR: directory,
        MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
        MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: draftKey,
        MAIL_INTELLIGENCE_JARVIS_READER_ENABLED: enabled ? '1' : '0',
        MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID: principal,
        MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE: keyFile,
        MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
        MAIL_INTELLIGENCE_ACTIONS_APPROVED: '1',
        MAIL_INTELLIGENCE_ALLOW_SEND: '1',
        MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '1',
        MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '1',
        MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
        MAIL_INTELLIGENCE_GRAPH_BASE_URL: providerUrl,
        MAIL_SEND_RECONCILIATION_INTERVAL_MS: '120000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Fixture readiness timed out')), 10000);
      const onExit = () => finish(new Error('Fixture exited before readiness'));
      const onError = () => finish(new Error('Fixture process failed to start'));
      const onData = chunk => {
        logs += chunk;
        if (logs.includes(`app running at ${base}`) && logs.includes('ready.')) finish();
      };
      const finish = error => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        child.stdout.off('data', onData);
        if (error) reject(error);
        else resolve();
      };
      child.once('exit', onExit);
      child.once('error', onError);
      child.stdout.on('data', onData);
      child.stderr.on('data', chunk => { logs += chunk; });
    });
    return { base, directory, databasePath, close,
      providerHits: () => providerHits,
      secretsLeaked: () => [readerKey, operatorKey, draftKey].some(key => logs.includes(key)),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function verifyJarvisMailReader({ capture = () => {} } = {}) {
  let checks = 0;
  for (const scenario of [
    { name: 'seeded', seeded: true, enabled: true },
    { name: 'empty', seeded: false, enabled: true },
    { name: 'disabled', seeded: false, enabled: false },
  ]) {
    const fixture = await startFixture(scenario);
    try {
      const before = databaseDigest(fixture.databasePath);
      const check = async (path, { method = 'GET', headers = readerHeaders, body } = {}, status, code) => {
        const response = await fetch(fixture.base + path, {
          method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        const result = text ? JSON.parse(text) : null;
        assert.equal(response.status, status, `${scenario.name}: ${method} ${path}`);
        assert.equal(response.headers.get('set-cookie'), null);
        if (code) assert.equal(result?.code, code);
        capture({ scenario: scenario.name, method, url: fixture.base + path,
          status: response.status, headers: Object.fromEntries(response.headers), body: result });
        checks += 1;
        return result;
      };
      if (!scenario.enabled) {
        await check('/api/storage/status', {}, 401, 'JARVIS_READER_UNAUTHENTICATED');
      } else {
        const summary = await check('/api/storage/status', {}, 200);
        assert.deepEqual(summary, {
          ready: true, counts: { messages: scenario.seeded ? 2 : 0, threads: scenario.seeded ? 1 : 0 },
        });
        for (const path of [
          '/api/mail/message?id=1', '/api/mail/search?q=fixture', '/api/mail/sent',
          '/api/intelligence/summary', '/api/outlook/config', '/api/session',
          '/api/health', '/', '/auth/callback?code=fixture&state=fixture',
          '/api/storage/status?mailbox=other', '/api/storage/status/',
          '/api/storage/%73tatus',
        ]) await check(path, {}, 403, 'JARVIS_READER_SCOPE_DENIED');
        for (const path of [
          '/api/outlook/send', '/api/outlook/mark-read', '/api/outlook/sync',
          '/api/mail/send-drafts', '/api/mail/send-drafts/fixture/approve',
          '/api/mail/send-drafts/fixture/send', '/api/messages/handled-elsewhere',
          '/api/intelligence/draft', '/api/intelligence/correct', '/api/outlook/config',
          '/api/storage/backup', '/api/data-plane/publish', '/api/session', '/api/storage/status',
        ]) await check(path, {
          method: 'POST', headers: { ...readerHeaders, 'Content-Type': 'application/json' }, body: '{}',
        }, 403, 'JARVIS_READER_SCOPE_DENIED');
        for (const method of ['HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
          await check('/api/storage/status', { method }, 403, method === 'HEAD' ? null : 'JARVIS_READER_SCOPE_DENIED');
        }
        for (const field of ['x-api-key', 'x-principal-id', 'x-principal-kind']) {
          const headers = { ...readerHeaders, [field]: 'wrong' };
          await check('/api/storage/status', { headers }, 401, 'JARVIS_READER_UNAUTHENTICATED');
          delete headers[field];
          await check('/api/storage/status', { headers }, 401, 'JARVIS_READER_UNAUTHENTICATED');
        }
        for (const headers of [
          { ...readerHeaders, Cookie: 'mi_session=synthetic-invalid' },
          { ...readerHeaders, Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
          { ...readerHeaders, Authorization: `Bearer ${draftKey}` },
          { ...readerHeaders, 'x-workspace-id': 'unbound-workspace' },
        ]) await check('/api/storage/status', { headers }, 403, 'JARVIS_READER_AUTH_CONFLICT');
        await check('/api/storage/status', { headers: {} }, 401, 'ACCESS_REQUIRED');
        await check('/api/mail/send-drafts', {
          method: 'POST', headers: { Authorization: `Bearer ${readerKey}`, 'Content-Type': 'application/json' }, body: '{}',
        }, 401);
      }
      const after = databaseDigest(fixture.databasePath);
      assert.equal(after, before, 'Reader requests changed persisted SQLite state');
      assert.equal(fixture.providerHits(), 0, 'Reader caused an upstream call');
      await assert.rejects(access(join(fixture.directory, '.mail-intelligence-sessions.json')), { code: 'ENOENT' });
      capture({ scenario: scenario.name, databaseDigestBefore: before, databaseDigestAfter: after,
        providerCalls: 0, sessionIssued: false, result: 'PASS' });

      // Adjacent human authority stays separate; no fixture session is reused by JARVIS.
      if (scenario.name === 'seeded') {
        const sessionResponse = await fetch(fixture.base + '/api/session', {
          headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
        });
        assert.equal(sessionResponse.status, 200);
        const session = await sessionResponse.json();
        const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
        await check('/api/storage/status', { headers: { Cookie: cookie } }, 200);
        await check('/api/outlook/config', {
          method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
        }, 403, 'MUTATION_PROTECTION_REQUIRED');
        await check('/api/mail/send-drafts/11111111-1111-4111-8111-111111111111/approve', {
          method: 'POST', headers: { Cookie: cookie, Origin: fixture.base, 'Content-Type': 'application/json' }, body: '{}',
        }, 403, 'CSRF_REQUIRED');
        const mixed = { ...readerHeaders, Cookie: cookie, 'X-CSRF-Token': session.csrfToken };
        await check('/api/mail/send-drafts', {
          method: 'POST', headers: { ...mixed, 'Content-Type': 'application/json' }, body: '{}',
        }, 403, 'JARVIS_READER_AUTH_CONFLICT');
        capture({ scenario: 'human-session-csrf-regression', status: 'PASS' });
      }
      assert.equal(fixture.secretsLeaked(), false);
    } finally {
      await fixture.close();
      await assert.rejects(access(fixture.directory), { code: 'ENOENT' });
      capture({ scenario: scenario.name, cleanup: 'PASS', childExited: true, temporaryDirectoryRemoved: true });
    }
  }
  return { result: 'PASS', checks, cleanup: 'PASS' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyJarvisMailReader({ capture: row => console.log(JSON.stringify(row)) });
  console.log(JSON.stringify(result));
}
