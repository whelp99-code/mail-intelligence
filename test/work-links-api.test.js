import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const FIXTURE = resolve('test/fixtures/notion-jm-business-os.snapshot.json');

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function graphMessage(id, subject, body, overrides = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { address: 'customer@example.com', name: '고객' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    receivedDateTime: '2026-09-11T00:00:00.000Z',
    sentDateTime: '2026-09-11T00:00:00.000Z',
    createdDateTime: '2026-09-11T00:00:00.000Z',
    lastModifiedDateTime: '2026-09-11T00:00:00.000Z',
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
    parentFolderId: 'inbox',
    ...overrides,
  });
}

function seed(dataDir) {
  const store = new SQLiteMailStore({
    databasePath: join(dataDir, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('syn-mail-quote', '[선진 HCI] 수정 견적서 요청', '수정 견적서를 보내주세요.'),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('syn-mail-thanks', '소개 미팅 감사합니다', '일정 조율', {
      from: { emailAddress: { address: 'hong@example.com', name: '홍길동' } },
    }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('syn-mail-newsletter', '주간 뉴스레터', '구독 감사합니다.', {
      from: { emailAddress: { address: 'noreply@news.example', name: 'News' } },
    }),
  });
  store.close();
}

async function waitForHealth(baseUrl, child, logs) {
  const ready = new Promise((resolveReady, rejectReady) => {
    const onData = () => {
      if (logs.join('').includes('app running at')) {
        child.stdout.off('data', onData);
        resolveReady();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => rejectReady(new Error(`server exited (${code}): ${logs.join('')}`)));
  });
  await Promise.race([
    ready,
    new Promise((_, rejectReady) => setTimeout(() => rejectReady(new Error(`server startup timed out: ${logs.join('')}`)), 5000)),
  ]);
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  return response.json();
}

test('work-links HTTP refresh uses fixture and never confirms', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mail-intelligence-worklinks-api-'));
  seed(dataDir);
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
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_NOTION_SNAPSHOT: FIXTURE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.kill('SIGTERM');
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  const health = await waitForHealth(baseUrl, child, logs);
  assert.equal(health.storage.schemaVersion, 8);
  assert.equal(health.safety.mode, 'read-only');

  const unauth = await fetch(`${baseUrl}/api/work-links`);
  assert.equal(unauth.status, 401);

  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const cookie = (sessionResponse.headers.get('set-cookie') || '').split(';')[0];
  const session = await sessionResponse.json();

  const blocked = await fetch(`${baseUrl}/api/work-links/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl, 'Content-Type': 'application/json' },
  });
  assert.equal(blocked.status, 403);

  const refresh = await fetch(`${baseUrl}/api/work-links/refresh`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken,
    },
    body: '{}',
  });
  const body = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(body));
  assert.equal(body.stats.linkedCandidate, 2);
  assert.equal(body.stats.unassigned, 1);
  assert.ok(body.links.every((item) => item.status === 'candidate'));

  const listed = await fetch(`${baseUrl}/api/work-links?messageId=syn-mail-quote`, {
    headers: { Cookie: cookie },
  });
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(listedBody.links[0].externalId, 'syn-project-sunjin-hci');
  assert.equal(listedBody.links[0].status, 'candidate');
});
