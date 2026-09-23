import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphSendClient, hasMailSendScope } from '../src/adapters/microsoft-graph-send.js';

const token = (scp = 'Mail.Read Mail.Send', exp = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ scp, exp })).toString('base64url')}.fixture`;
const draft = {
  draft_id: 'ea06c1bb-768c-4910-9daf-53777ec466ed', status: 'sending',
  approved_by: 'session:owner', approved_at: '2026-09-09T00:00:00Z',
  to: ['test@example.com'], cc: [], subject: 'Fixture only', body_text: 'No real email.\nFixture.',
};
const sent = () => ({
  id: 'immutable-graph-fixture', isDraft: false, subject: draft.subject,
  body: { contentType: 'text', content: draft.body_text },
  toRecipients: [{ emailAddress: { address: 'test@example.com' } }], ccRecipients: [],
  internetMessageHeaders: [{ name: 'x-mi-draft-id', value: draft.draft_id }],
  sentDateTime: '2026-09-09T00:00:01Z',
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('scope preflight rejects missing/expired/opaque tokens', () => {
  assert.equal(hasMailSendScope(token()), true);
  for (const value of ['', 'opaque', token('Mail.Read'), token('Mail.Send', 1)]) assert.equal(hasMailSendScope(value), false);
});

test('flag OFF, no scope or unapproved draft causes zero HTTP calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  const client = new GraphSendClient({ accessToken: token(), fetchImpl });
  await assert.rejects(client.sendOnce(draft), { code: 'MAIL_SEND_DISABLED' });
  await assert.rejects(client.sendOnce({ ...draft, status: 'needs_approval' }, { allowSend: true }), { code: 'HUMAN_APPROVAL_REQUIRED' });
  await assert.rejects(new GraphSendClient({ accessToken: token('Mail.Read'), fetchImpl }).sendOnce(draft, { allowSend: true }), { code: 'MAIL_SEND_SCOPE_REQUIRED' });
  assert.equal(calls, 0);
});

test('configured recipient allowlist rejects disallowed to and cc with zero HTTP calls', async () => {
  for (const changed of [
    { to: ['blocked@example.com'] },
    { cc: ['blocked@example.com'] },
  ]) {
    let calls = 0;
    const client = new GraphSendClient({
      accessToken: token(),
      recipientAllowlist: ['test@example.com'],
      fetchImpl: async () => { calls++; throw new Error('must not call'); },
    });
    await assert.rejects(client.sendOnce({ ...draft, ...changed }, { allowSend: true }), { code: 'RECIPIENT_NOT_ALLOWED' });
    assert.equal(calls, 0);
  }
});

test('one approved POST then matching Sent Items receipt', async () => {
  const calls = [];
  const client = new GraphSendClient({ accessToken: token(), fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return options.method === 'POST' ? new Response(null, { status: 202 }) : json({ value: [sent()] });
  } });
  const result = await client.sendOnce(draft, { allowSend: true });
  assert.equal(result.graphMessageId, 'immutable-graph-fixture');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.saveToSentItems, true);
  assert.equal(payload.message.internetMessageHeaders[0].value, draft.draft_id);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].url, 'https://graph.microsoft.com/v1.0/me/sendMail');
});

test('202 without receipt remains pending, never fabricates a graph ID', async () => {
  let posts = 0;
  const client = new GraphSendClient({ accessToken: token(), fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts++; return new Response(null, { status: 202 }); }
    return json({ value: [] });
  } });
  const result = await client.sendOnce(draft, { allowSend: true });
  assert.deepEqual(result, { uncertain: true, failureCode: 'GRAPH_RECEIPT_PENDING' });
  await client.reconcile(draft);
  assert.equal(posts, 1);
});

test('POST network failure returns unknown with no retry or sensitive error', async () => {
  let calls = 0;
  const client = new GraphSendClient({ accessToken: token(), fetchImpl: async () => { calls++; throw new Error('secret-token-and-private-body'); } });
  assert.deepEqual(await client.sendOnce(draft, { allowSend: true }), { uncertain: true, failureCode: 'GRAPH_ACCEPTANCE_UNKNOWN' });
  assert.equal(calls, 1);
});

test('HTTP rejection and server failure do not retry', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const client = new GraphSendClient({ accessToken: token(), fetchImpl: async () => { calls++; return json({ secret: 'never returned' }, status); } });
    const result = await client.sendOnce(draft, { allowSend: true });
    assert.equal(result.uncertain, status >= 500);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('never returned'), false);
  }
});

test('receipt must match recipient, subject, body and sent state', async () => {
  for (const change of [{ subject: 'Wrong' }, { body: { contentType: 'text', content: 'Wrong' } }, { toRecipients: [] }, { isDraft: true }, { sentDateTime: 'invalid' }]) {
    const client = new GraphSendClient({ accessToken: token(), fetchImpl: async () => json({ value: [{ ...sent(), ...change }] }) });
    assert.equal((await client.reconcile(draft)).failureCode, 'GRAPH_RECEIPT_PAYLOAD_MISMATCH');
  }
});

test('duplicate receipts cannot be treated as one successful send', async () => {
  const client = new GraphSendClient({ accessToken: token(), fetchImpl: async () => json({ value: [sent(), { ...sent(), id: 'second' }] }) });
  assert.equal((await client.reconcile(draft)).failureCode, 'GRAPH_RECEIPT_AMBIGUOUS');
});

test('continuation cannot exfiltrate credentials outside exact Sent Items path', async () => {
  for (const next of ['https://evil.example/path', 'https://graph.microsoft.com/v1.0/me/messages', 'https://evil@graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages']) {
    let calls = 0;
    const client = new GraphSendClient({ accessToken: token(), fetchImpl: async () => { calls++; return json({ value: [sent()], '@odata.nextLink': next }); } });
    assert.equal((await client.reconcile(draft)).failureCode, 'GRAPH_RECEIPT_SCAN_INCOMPLETE');
    assert.equal(calls, 1);
  }
});

test('read reconciliation error is unknown and never sends', async () => {
  const methods = [];
  const client = new GraphSendClient({ accessToken: token(), fetchImpl: async (_url, options) => { methods.push(options.method); return json({}, 503); } });
  assert.equal((await client.reconcile(draft)).failureCode, 'GRAPH_RECEIPT_UNAVAILABLE');
  assert.deepEqual(methods, ['GET']);
});
