import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GraphSendClient } from '../src/adapters/microsoft-graph-send.js';
import { sendInquiryNotification, INQUIRY_NOTIFY_RECIPIENT } from '../src/application/inquiry-notification-draft.js';

const token = (scp = 'Mail.Read Mail.Send', exp = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ scp, exp })).toString('base64url')}.fixture`;

const inquiry = {
  id: 'inq-1001',
  name: '김시험',
  contact: '010-0000-0000',
  body: '견적 문의입니다.',
  receivedAt: '2026-11-08T02:08:00.000Z',
  email: 'secret-extra@example.com',
  ip: '203.0.113.9',
};

function readyConfig() {
  return { notifyEnabled: true, accessToken: token() };
}

test('missing inquiry notification config records INQUIRY_NOTIFY_CONFIG_MISSING and does not call fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not call'); };
  const cases = [
    {},
    { fetchImpl, sentIds: new Set(), config: null },
    { fetchImpl, sentIds: new Set(), config: { accessToken: token() } },
    { fetchImpl, sentIds: new Set(), config: { notifyEnabled: false, accessToken: token() } },
    { fetchImpl, sentIds: new Set(), config: { notifyEnabled: true } },
    { fetchImpl, sentIds: new Set(), config: { notifyEnabled: true, accessToken: token('Mail.Read') } },
    { sentIds: new Set(), config: readyConfig() },
    { fetchImpl, config: readyConfig() },
    { fetchImpl, sentIds: {}, config: readyConfig() },
  ];
  for (const input of cases) {
    const result = await sendInquiryNotification({ recipient: INQUIRY_NOTIFY_RECIPIENT, inquiry, ...input });
    assert.equal(result.sent, false);
    assert.equal(result.failureCode, 'INQUIRY_NOTIFY_CONFIG_MISSING');
  }
  assert.equal(calls, 0);
});

test('a recipient other than jm.park@blro.co.kr is rejected before Graph send', async () => {
  const blocked = ['', 'other@blro.co.kr', 'jm.park@example.com', 'jm.park@blro.co.kr.evil.test', `evil@example.com, ${INQUIRY_NOTIFY_RECIPIENT}`, ['jm.park@blro.co.kr']];
  for (const recipient of blocked) {
    let calls = 0;
    const result = await sendInquiryNotification({
      inquiry,
      recipient,
      config: readyConfig(),
      fetchImpl: async () => { calls += 1; throw new Error('must not call'); },
      sentIds: new Set(),
    });
    assert.equal(result.failureCode, 'INQUIRY_NOTIFY_RECIPIENT_REJECTED');
    assert.equal(calls, 0);
  }
});

test('inquiry notification sends once through GraphSendClient with only name, contact, body, and received time', async () => {
  const calls = [];
  const sentIds = new Set();
  let usedSendOnce = false;
  const result = await sendInquiryNotification({
    inquiry,
    recipient: '  JM.Park@blro.co.kr  ',
    config: readyConfig(),
    sentIds,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 202 });
    },
    clientFactory(options) {
      const client = new GraphSendClient(options);
      client.sendOnce = async () => { usedSendOnce = true; throw new Error('reply approval path must not be used'); };
      return client;
    },
  });
  assert.equal(result.sent, true);
  assert.equal(result.inquiryId, inquiry.id);
  assert.equal(usedSendOnce, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(new URL(calls[0].url).hostname, 'graph.microsoft.com');
  const posted = JSON.parse(calls[0].options.body);
  const content = posted.message.body.content;
  assert.equal(content, [
    '이름: 김시험',
    '연락처: 010-0000-0000',
    '문의 본문: 견적 문의입니다.',
    '접수 시각: 2026-11-08T02:08:00.000Z',
  ].join('\n'));
  assert.equal(content.includes(inquiry.email), false);
  assert.equal(content.includes(inquiry.ip), false);
  assert.equal(content.includes(inquiry.id), false);
  assert.deepEqual(posted.message.toRecipients, [{ emailAddress: { address: INQUIRY_NOTIFY_RECIPIENT } }]);
  assert.deepEqual(posted.message.ccRecipients, []);
  assert.equal(calls[0].options.headers.Authorization.startsWith('Bearer fixture.'), true);
  assert.equal(sentIds.has(inquiry.id), true);
});

test('the same inquiry id is not sent twice', async () => {
  let calls = 0;
  const sentIds = new Set();
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 202 });
  };
  const first = await sendInquiryNotification({
    inquiry, recipient: INQUIRY_NOTIFY_RECIPIENT, config: readyConfig(), fetchImpl, sentIds,
  });
  const second = await sendInquiryNotification({
    inquiry, recipient: INQUIRY_NOTIFY_RECIPIENT, config: readyConfig(), fetchImpl, sentIds,
  });
  assert.equal(first.sent, true);
  assert.equal(second.failureCode, 'INQUIRY_ALREADY_NOTIFIED');
  assert.equal(calls, 1);
});

test('an uncertain Graph attempt still blocks a second send', async () => {
  let calls = 0;
  const sentIds = new Set();
  const fetchImpl = async () => { calls += 1; throw new Error('double failed closed'); };
  const first = await sendInquiryNotification({
    inquiry, recipient: INQUIRY_NOTIFY_RECIPIENT, config: readyConfig(), fetchImpl, sentIds,
  });
  const second = await sendInquiryNotification({
    inquiry, recipient: INQUIRY_NOTIFY_RECIPIENT, config: readyConfig(), fetchImpl, sentIds,
  });
  assert.equal(first.failureCode, 'INQUIRY_NOTIFY_UNCERTAIN');
  assert.equal(second.failureCode, 'INQUIRY_ALREADY_NOTIFIED');
  assert.equal(calls, 1);
});

test('global fetch and live graph calls are refused', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('live graph must not be called'); };
  try {
    const result = await sendInquiryNotification({
      inquiry,
      recipient: INQUIRY_NOTIFY_RECIPIENT,
      config: readyConfig(),
      fetchImpl: globalThis.fetch,
      sentIds: new Set(),
    });
    assert.equal(result.failureCode, 'INQUIRY_NOTIFY_CONFIG_MISSING');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('inquiry notification draft is not wired into operational server send', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('inquiry-notification-draft'), false);
  assert.equal(source.includes('/sendMail'), false);
});
