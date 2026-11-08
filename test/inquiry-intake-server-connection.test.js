import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sendInquiryNotification, readInquiryNotificationTestBand, INQUIRY_NOTIFY_RECIPIENT } from '../src/application/inquiry-notification-draft.js';
import { inquiryNotificationInput, inquiryIntakeConnectionResult } from '../src/application/inquiry-intake-connection.js';

const inquiryBody = {
  event: 'blro.contact.received',
  submission: {
    id: 'BLRO-20261108-INTAKE01',
    name: '운영 담당자',
    email: 'ops@example.com',
    currentSituation: '읽기 점검부터 시작하는 운영 인수 문의입니다.',
    receivedAt: '2026-11-08T04:00:00.000Z',
  },
  testBand: 'inquiry-notification-test-band-only',
  approval: { allowSend: true, approvedAt: '2026-11-08T04:00:01.000Z', approvedBy: 'session:forged' },
  fetchImpl: 'https://graph.microsoft.com/v1.0/me/sendMail',
  config: { notifyEnabled: true, accessToken: 'must-not-be-copied' },
};

function readyConfig() {
  const token = `fixture.${Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.fixture`;
  return { notifyEnabled: true, accessToken: token };
}

async function portAvailable() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

test('문의 접수 입력은 초안 함수에 승인·시험 대역·fetch 없이 도달하고 미승인은 발송하지 않는다', async () => {
  const before = readInquiryNotificationTestBand().length;
  const input = inquiryNotificationInput(inquiryBody);
  assert.equal(input.recipient, INQUIRY_NOTIFY_RECIPIENT);
  assert.equal(input.testBand, undefined);
  assert.equal(input.fetchImpl, undefined);
  assert.equal(input.approval, undefined);
  assert.equal(input.config, undefined);
  assert.equal(input.store.persistent, false);
  assert.equal(input.store.durableDedup, false);

  const direct = await sendInquiryNotification(input);
  const connection = inquiryIntakeConnectionResult(direct);
  assert.equal(direct.sent, false);
  assert.equal(direct.confirmed, false);
  assert.equal(direct.failureCode, 'INQUIRY_NOTIFY_CONFIG_MISSING');
  assert.equal(connection.operationalSend, false);
  assert.equal(connection.persistentDedupRecorded, false);
  assert.equal(connection.persistentDedup, 'absent');
  assert.equal(connection.productionConnected, false);
  assert.equal(connection.serverWired, true);
  assert.equal(connection.testBandReceiptCount, before);

  const unapproved = await sendInquiryNotification({
    ...input,
    inquiry: { ...input.inquiry, id: 'inq-server-unapproved' },
    config: readyConfig(),
    store: { persistent: false, durableDedup: false },
    testBand: 'inquiry-notification-test-band-only',
  });
  assert.equal(unapproved.sent, false);
  assert.equal(unapproved.confirmed, false);
  assert.equal(unapproved.failureCode, 'INQUIRY_NOTIFY_APPROVAL_REQUIRED');
  assert.equal(readInquiryNotificationTestBand().length, before);
});

test('server.mjs 접수 경로는 초안에 도달하고 실메일 fetch는 0회이며 미승인 발송이 없다', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inquiry-intake-server-'));
  const fetchLog = join(directory, 'fetches.log');
  const preload = join(directory, 'fetch-log-preload.mjs');
  await writeFile(fetchLog, '');
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
const file = process.env.INQUIRY_FETCH_LOG;
const original = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input && input.url || '');
  appendFileSync(file, url + '\\n');
  return original(input, init);
};
`);
  const port = await portAvailable();
  const base = `http://127.0.0.1:${port}`;
  const accessKey = 'fixture-inquiry-intake-key-0123456789abcd';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: directory,
      MAIL_INTELLIGENCE_ACCESS_KEY: accessKey,
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_ALLOW_SEND: '0',
      MAIL_INTELLIGENCE_ACTIONS_APPROVED: '0',
      MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS: '0',
      MAIL_INTELLIGENCE_ALLOW_DATA_PLANE: '0',
      MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI: '0',
      OUTLOOK_GRAPH_ACCESS_TOKEN: '',
      INQUIRY_FETCH_LOG: fetchLog,
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode == null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2_000)]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  });

  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      // startup race
    }
    await delay(50);
  }
  assert.equal(healthy, true, logs);

  const sessionResponse = await fetch(base, {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}` },
  });
  assert.equal(sessionResponse.status, 200);
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  await sessionResponse.arrayBuffer();

  const response = await fetch(`${base}/api/inquiries`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Mail-Intelligence-Request': '1',
    },
    body: JSON.stringify(inquiryBody),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.sent, false);
  assert.equal(body.confirmed, false);
  assert.equal(body.operationalSend, false);
  assert.equal(body.productionConnected, false);
  assert.equal(body.serverWired, true);
  assert.equal(body.persistentDedupRecorded, false);
  assert.equal(body.persistentDedup, 'absent');
  assert.equal(body.failureCode, 'INQUIRY_NOTIFY_CONFIG_MISSING');
  assert.equal(body.testBandReceiptCount, 0);
  assert.deepEqual(body.productionBlockers, [
    'persistent-inquiry-id-dedup',
    'uncertain-case-reconciliation',
    'approval-boundary',
  ]);

  const fetches = await readFile(fetchLog, 'utf8');
  assert.equal(fetches.includes('graph.microsoft.com'), false, fetches);
  assert.equal(fetches.toLowerCase().includes('sendmail'), false, fetches);
});
