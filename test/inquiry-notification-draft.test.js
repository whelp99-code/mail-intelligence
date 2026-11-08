import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sendInquiryNotification,
  INQUIRY_NOTIFY_RECIPIENT,
  INQUIRY_NOTIFY_TEST_BAND,
} from '../src/application/inquiry-notification-draft.js';

const token = (scp = 'Mail.Read Mail.Send', exp = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ scp, exp })).toString('base64url')}.fixture`;

function inquiry(id = 'inq-1001') {
  return {
    id,
    name: '김시험',
    contact: '010-0000-0000',
    body: '견적 문의입니다.',
    receivedAt: '2026-11-08T02:08:00.000Z',
    email: 'secret-extra@example.com',
    ip: '203.0.113.9',
  };
}

function readyConfig() {
  return { notifyEnabled: true, accessToken: token() };
}

function approval() {
  return {
    allowSend: true,
    approvedAt: '2026-11-08T02:08:00.000Z',
    approvedBy: 'session:inquiry-fixture',
  };
}

function store() {
  return { contract: INQUIRY_NOTIFY_TEST_BAND, persistent: false };
}

function harnessInput(id, fetchImpl, handle = store()) {
  return {
    inquiry: inquiry(id),
    recipient: INQUIRY_NOTIFY_RECIPIENT,
    config: readyConfig(),
    fetchImpl,
    store: handle,
    testBand: INQUIRY_NOTIFY_TEST_BAND,
    approval: approval(),
  };
}

function assertHarnessContract(result) {
  assert.equal(result.contract, INQUIRY_NOTIFY_TEST_BAND);
  assert.equal(result.harnessOnly, true);
  assert.equal(result.productionConnected, false);
  assert.equal(result.serverWired, false);
  assert.equal(result.retryable, false);
  assert.equal(result.unsentConfirmed, false);
  assert.deepEqual(result.productionBlockers, [
    'persistent-inquiry-id-dedup',
    'uncertain-case-reconciliation',
    'approval-boundary',
  ]);
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
    { fetchImpl, sentIds: new Set(), store: new Set(), config: readyConfig() },
  ];
  for (const input of cases) {
    const result = await sendInquiryNotification({ recipient: INQUIRY_NOTIFY_RECIPIENT, inquiry: inquiry(), ...input });
    assert.equal(result.sent, false);
    assert.equal(result.failureCode, 'INQUIRY_NOTIFY_CONFIG_MISSING');
    assertHarnessContract(result);
  }
  assert.equal(calls, 0);
});

test('a recipient other than jm.park@blro.co.kr is rejected before Graph send', async () => {
  const blocked = ['', 'other@blro.co.kr', 'jm.park@example.com', 'jm.park@blro.co.kr.evil.test', `evil@example.com, ${INQUIRY_NOTIFY_RECIPIENT}`, ['jm.park@blro.co.kr']];
  for (const recipient of blocked) {
    let calls = 0;
    const result = await sendInquiryNotification({
      ...harnessInput('inq-recipient', async () => { calls += 1; throw new Error('must not call'); }),
      recipient,
    });
    assert.equal(result.failureCode, 'INQUIRY_NOTIFY_RECIPIENT_REJECTED');
    assert.equal(calls, 0);
  }
});

test('시험 대역 전용 계약: 202는 sent가 아님', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = await sendInquiryNotification(harnessInput('inq-202', fetchImpl, { handle: 'first' }));
  const second = await sendInquiryNotification({
    ...harnessInput('inq-202', fetchImpl, { handle: 'second' }),
    sentIds: new Set(),
  });
  assert.equal(first.sent, false);
  assert.equal(first.accepted, true);
  assert.equal(first.confirmed, false);
  assert.equal(first.failureCode, 'INQUIRY_NOTIFY_UNCERTAIN');
  assert.equal(first.retryable, false);
  assert.equal(first.unsentConfirmed, false);
  assertHarnessContract(first);
  assert.equal(second.failureCode, 'INQUIRY_ALREADY_NOTIFIED');
  assert.equal(second.resendBlocked, true);
  assert.equal(second.sent, false);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'graph.microsoft.com');
});

test('시험 대역 전용 계약: 영수증 확인만 confirmed', async () => {
  const calls = [];
  let posted = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body, authorization: options.headers?.Authorization });
    if (options.method === 'POST') {
      posted = JSON.parse(options.body);
      return new Response(null, { status: 202 });
    }
    const header = posted.message.internetMessageHeaders[0];
    const receipt = {
      id: 'graph-inquiry-fixture',
      isDraft: false,
      subject: posted.message.subject,
      body: { contentType: 'text', content: posted.message.body.content },
      toRecipients: posted.message.toRecipients,
      ccRecipients: posted.message.ccRecipients,
      internetMessageHeaders: [header],
      sentDateTime: '2026-11-08T02:08:01.000Z',
    };
    return new Response(JSON.stringify({ value: [receipt] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await sendInquiryNotification({
    ...harnessInput('inq-confirmed', fetchImpl),
    recipient: '  JM.Park@blro.co.kr  ',
    inquiry: inquiry('inq-confirmed'),
  });
  assert.equal(result.sent, true);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.graphMessageId, 'graph-inquiry-fixture');
  assert.equal(result.failureCode, undefined);
  assertHarnessContract(result);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  const content = posted.message.body.content;
  assert.equal(content, [
    '이름: 김시험',
    '연락처: 010-0000-0000',
    '문의 본문: 견적 문의입니다.',
    '접수 시각: 2026-11-08T02:08:00.000Z',
  ].join('\n'));
  const item = inquiry('inq-confirmed');
  assert.equal(content.includes(item.email), false);
  assert.equal(content.includes(item.ip), false);
  assert.equal(content.includes(item.id), false);
  assert.deepEqual(posted.message.toRecipients, [{ emailAddress: { address: INQUIRY_NOTIFY_RECIPIENT } }]);
  assert.deepEqual(posted.message.ccRecipients, []);
  assert.equal(String(calls[0].authorization || '').startsWith('Bearer fixture.'), true);
  assert.equal(posted.message.internetMessageHeaders[0].name, 'x-mi-draft-id');
});

test('시험 대역 전용 계약: 유실은 INQUIRY_NOTIFY_UNCERTAIN이고 재전송하지 않음', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('response lost'); };
  const first = await sendInquiryNotification(harnessInput('inq-loss', fetchImpl, { handle: 'loss-1' }));
  const second = await sendInquiryNotification({
    ...harnessInput('inq-loss', fetchImpl, { handle: 'loss-2' }),
    sentIds: new Set(),
  });
  assert.equal(first.sent, false);
  assert.equal(first.accepted, false);
  assert.equal(first.confirmed, false);
  assert.equal(first.failureCode, 'INQUIRY_NOTIFY_UNCERTAIN');
  assert.equal(first.retryable, false);
  assert.equal(first.unsentConfirmed, false);
  assertHarnessContract(first);
  assert.equal(second.failureCode, 'INQUIRY_ALREADY_NOTIFIED');
  assert.equal(second.resendBlocked, true);
  assert.equal(second.retryable, false);
  assert.equal(calls, 1);
});

test('시험 대역 전용 계약: 새 저장 핸들로 같은 id 재요청 거부', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (options.method === 'POST') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const first = await sendInquiryNotification(harnessInput('inq-dedup', fetchImpl, { generation: 1 }));
  const second = await sendInquiryNotification(harnessInput('inq-dedup', fetchImpl, { generation: 2 }));
  assert.equal(first.sent, false);
  assert.equal(first.contract, INQUIRY_NOTIFY_TEST_BAND);
  assert.equal(second.failureCode, 'INQUIRY_ALREADY_NOTIFIED');
  assert.equal(second.resendBlocked, true);
  assert.equal(second.sent, false);
  assert.equal(second.retryable, false);
  assertHarnessContract(second);
  assert.equal(calls, 2);
});

test('감싼 global fetch 거부', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('live graph must not be called'); };
  const wrapped = async (url, options) => globalThis.fetch(url, options);
  const bound = globalThis.fetch.bind(globalThis);
  try {
    assert.notEqual(wrapped, globalThis.fetch);
    for (const fetchImpl of [globalThis.fetch, wrapped, bound]) {
      const result = await sendInquiryNotification(harnessInput('inq-wrap', fetchImpl, store()));
      assert.equal(result.sent, false);
      assert.equal(result.failureCode, 'INQUIRY_NOTIFY_LIVE_GRAPH_REFUSED');
      assertHarnessContract(result);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('graph.microsoft.com 호출은 시험 대역이 아니면 거절', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(null, { status: 202 }); };
  const result = await sendInquiryNotification({
    ...harnessInput('inq-band', fetchImpl),
    testBand: undefined,
  });
  assert.equal(result.failureCode, 'INQUIRY_NOTIFY_TEST_BAND_REQUIRED');
  assert.equal(result.sent, false);
  assert.equal(calls, 0);
  assertHarnessContract(result);
});

test('server.mjs 미연결', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('inquiry-notification-draft'), false);
  assert.equal(source.includes('sendInquiryNotification'), false);
  assert.equal(source.includes('/sendMail'), false);
});
