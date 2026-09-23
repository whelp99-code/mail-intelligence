import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { encodeUploadFileName } from '../src/application/mail-attachment-api.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startIsolated(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mi-attach-http-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operatorKey = 'fixture-operator-key-012345678901234567890123';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: directory,
      MAIL_INTELLIGENCE_ACCESS_KEY: operatorKey,
      MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN: 'fixture-service-key-012345678901234567890123',
      MAIL_INTELLIGENCE_GROK_DRAFT_TOKEN_FILE: '',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      OUTLOOK_GRAPH_ACCESS_TOKEN: 'opaque-fixture-without-send-scope',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = createInterface({ input: child.stdout });
  const started = new Promise((resolve, reject) => {
    output.on('line', (line) => {
      if (line.includes(`app running at ${base}`)) resolve();
    });
    child.once('exit', (code) => reject(new Error(`isolated server exited before startup: ${code}`)));
  });
  t.after(async () => {
    output.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  await started;
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, 'isolated attachment server should start');
  const root = await fetch(base, {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${operatorKey}`).toString('base64')}` },
  });
  const cookie = root.headers.get('set-cookie').split(';')[0];
  await root.arrayBuffer();
  const session = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json();
  return { base, cookie, session };
}

test('isolated server keeps attachment API disabled when flags are OFF', { timeout: 15_000 }, async (t) => {
  const { base, cookie, session } = await startIsolated(t, {
    MAIL_ATTACHMENTS_ENABLED: '0',
    MAIL_DRIVE_ENABLED: '0',
  });
  const response = await fetch(`${base}/api/mail/attachment-assets`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: base,
      'X-CSRF-Token': session.csrfToken,
      'X-Upload-Request-Id': randomUUID(),
      'X-File-Name': encodeUploadFileName('note.txt'),
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from('hello'),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'ATTACHMENTS_DISABLED');
  const html = await (await fetch(base, { headers: { Cookie: cookie } })).text();
  assert.match(html, /id="attachLocalFiles"/);
  assert.match(html, /id="attachDriveFiles"/);
  assert.match(html, /id="attachDriveLink"/);
});

test('isolated unused-port server uploads a synthetic file when attachments are injected on', { timeout: 15_000 }, async (t) => {
  const { base, cookie, session } = await startIsolated(t, {
    MAIL_ATTACHMENTS_ENABLED: '1',
    MAIL_DRIVE_ENABLED: '0',
    MAIL_ATTACHMENT_KEY: '11'.repeat(32),
    MAIL_ATTACHMENT_SCANNER_COMMAND: '/bin/true',
  });
  const missingCsrf = await fetch(`${base}/api/mail/attachment-assets`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: base,
      'X-Upload-Request-Id': randomUUID(),
      'X-File-Name': encodeUploadFileName('note.txt'),
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from('hello'),
  });
  assert.equal(missingCsrf.status, 403);
  const uploaded = await fetch(`${base}/api/mail/attachment-assets`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: base,
      'X-CSRF-Token': session.csrfToken,
      'X-Upload-Request-Id': randomUUID(),
      'X-File-Name': encodeUploadFileName('회의록.txt'),
      'Content-Type': 'application/octet-stream',
    },
    body: Buffer.from('한글본문'),
  });
  assert.equal(uploaded.status, 201);
  const body = await uploaded.json();
  assert.equal(body.name, '회의록.txt');
  assert.equal(body.state, 'ready');
  const download = await fetch(`${base}/api/mail/attachment-assets/${body.id}/content`, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') || '', /attachment/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await download.arrayBuffer()).toString('utf8'), '한글본문');
});

test('human reviews a Grok draft attachment over HTTP without granting bearer download or send', { timeout: 15000 }, async (t) => {
  const { base, cookie } = await startIsolated(t, {
    MAIL_ATTACHMENTS_ENABLED: '1',
    MAIL_DRIVE_ENABLED: '0',
    MAIL_ATTACHMENT_KEY: '11'.repeat(32),
    MAIL_ATTACHMENT_SCANNER_COMMAND: '/bin/true',
  });
  const authorization = 'Bearer fixture-service-key-012345678901234567890123';
  const bytes = Buffer.from('synthetic bot draft attachment');
  const upload = await fetch(`${base}/api/mail/attachment-assets`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'X-Upload-Request-Id': randomUUID(),
      'X-File-Name': encodeUploadFileName('bot-review.txt'),
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  assert.equal(upload.status, 201);
  const asset = await upload.json();
  const created = await fetch(`${base}/api/mail/send-drafts`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request_id: randomUUID(), to: ['review@example.test'],
      subject: 'Synthetic review', body_text: 'Review before approval.',
      attachment_ids: [asset.id],
    }),
  });
  assert.equal(created.status, 201);
  const { draft } = await created.json();
  assert.equal(draft.status, 'needs_approval');
  const review = await fetch(`${base}/api/mail/send-drafts/${draft.draft_id}`, { headers: { Cookie: cookie } });
  assert.equal(review.status, 200);
  const reviewed = await review.json();
  assert.equal(reviewed.send_enabled, false);
  assert.equal(reviewed.draft.attachments[0].id, asset.id);
  const contentUrl = `${base}/api/mail/attachment-assets/${asset.id}/content`;
  const denied = await fetch(contentUrl, { headers: { Authorization: authorization, Cookie: cookie } });
  assert.equal(denied.status, 403);
  const downloaded = await fetch(contentUrl, { headers: { Cookie: cookie } });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /^attachment;/);
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
});
