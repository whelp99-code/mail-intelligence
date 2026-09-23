import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GraphSendClient } from '../src/adapters/microsoft-graph-send.js';

const token = (scp = 'Mail.Read Mail.Send', exp = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ scp, exp })).toString('base64url')}.fixture`;
const bytes = Buffer.from('graph-attachment-bytes', 'utf8');
const sha = createHash('sha256').update(bytes).digest('hex');
const draft = {
  draft_id: 'aa11c1bb-768c-4910-9daf-53777ec466ed',
  status: 'sending',
  approved_by: 'session:owner',
  approved_at: '2026-09-09T00:00:00Z',
  to: ['test@example.com'],
  cc: [],
  subject: 'Attachment fixture',
  body_text: 'No real email.',
  attachments: [{
    ordinal: 0,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'note.txt',
    mime: 'text/plain',
    size: bytes.length,
    sha256: sha,
    origin: 'local',
    drive_version: null,
    export_mime: null,
  }],
};
const sent = () => ({
  id: 'immutable-graph-attach',
  isDraft: false,
  subject: draft.subject,
  body: { contentType: 'text', content: draft.body_text },
  toRecipients: [{ emailAddress: { address: 'test@example.com' } }],
  ccRecipients: [],
  internetMessageHeaders: [{ name: 'x-mi-draft-id', value: draft.draft_id }],
  sentDateTime: '2026-09-09T00:00:01Z',
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const binary = (payload, status = 200) => new Response(payload, { status, headers: { 'Content-Type': 'application/octet-stream' } });

function clientWith(handler) {
  return new GraphSendClient({ accessToken: token(), fetchImpl: handler });
}

test('sendOnce posts fileAttachment bytes and confirms receipt hashes', async () => {
  const calls = [];
  const client = clientWith(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (options.method === 'POST') return new Response(null, { status: 202 });
    if (url.includes('/attachments/') && url.endsWith('/$value')) return binary(bytes);
    if (url.includes('/attachments')) return json({ value: [{ id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: bytes.length, isInline: false }] });
    return json({ value: [sent()] });
  });
  const result = await client.sendOnce(draft, {
    allowSend: true,
    attachments: [{ name: 'note.txt', mime: 'text/plain', bytes }],
  });
  assert.equal(result.graphMessageId, 'immutable-graph-attach');
  const post = calls.find((item) => item.method === 'POST');
  const payload = JSON.parse(post.body);
  assert.equal(payload.message.attachments[0]['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(payload.message.attachments[0].contentBytes, bytes.toString('base64'));
  assert.equal(calls.filter((item) => item.method === 'POST').length, 1);
});

test('Graph 202 without matching attachment bytes stays sending', async () => {
  for (const handler of [
    async (_url, options = {}) => (options.method === 'POST' ? new Response(null, { status: 202 }) : json({ value: [sent()] })),
    async (url, options = {}) => {
      if (options.method === 'POST') return new Response(null, { status: 202 });
      if (url.includes('/attachments')) return json({ value: [] });
      return json({ value: [sent()] });
    },
    async (url, options = {}) => {
      if (options.method === 'POST') return new Response(null, { status: 202 });
      if (url.includes('/$value')) return binary(Buffer.from('other'));
      if (url.includes('/attachments')) return json({ value: [{ id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: 5, isInline: false }] });
      return json({ value: [sent()] });
    },
    async (url, options = {}) => {
      if (options.method === 'POST') return new Response(null, { status: 202 });
      if (url.includes('/attachments')) {
        return json({
          value: [
            { id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: bytes.length, isInline: false },
            { id: 'att-2', name: 'extra.txt', contentType: 'text/plain', size: 1, isInline: false },
          ],
        });
      }
      return json({ value: [sent()] });
    },
  ]) {
    const result = await clientWith(handler).sendOnce(draft, {
      allowSend: true,
      attachments: [{ name: 'note.txt', mime: 'text/plain', bytes }],
    });
    assert.equal(result.uncertain, true);
    assert.ok(result.failureCode);
    assert.equal(result.graphMessageId, undefined);
  }
});

test('attachment list pagination is fully consumed and extra pages cannot be truncated into success', async () => {
  const calls = [];
  const client = clientWith(async (url, options = {}) => {
    calls.push(url);
    if (options.method === 'POST') return new Response(null, { status: 202 });
    if (url.includes('/attachments/') && url.endsWith('/$value')) return binary(bytes);
    if (url.includes('/attachments') && url.includes('skiptoken')) {
      return json({ value: [{ id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: bytes.length, isInline: false }] });
    }
    if (url.includes('/attachments')) {
      return json({
        value: [],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages/immutable-graph-attach/attachments?$skiptoken=2',
      });
    }
    return json({ value: [sent()] });
  });
  const result = await client.sendOnce(draft, {
    allowSend: true,
    attachments: [{ name: 'note.txt', mime: 'text/plain', bytes }],
  });
  assert.equal(result.graphMessageId, 'immutable-graph-attach');
  assert.equal(calls.some((url) => String(url).includes('skiptoken')), true);
});

test('oversized attachment receipt is not treated as success by the 2MiB reader', async () => {
  const huge = Buffer.alloc((2 * 1024 * 1024) + 8, 0x61);
  const truncatedHash = createHash('sha256').update(huge.subarray(0, 2 * 1024 * 1024)).digest('hex');
  const client = clientWith(async (url, options = {}) => {
    if (options.method === 'POST') return new Response(null, { status: 202 });
    if (url.includes('/$value')) return binary(huge);
    if (url.includes('/attachments')) return json({ value: [{ id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: huge.length, isInline: false }] });
    return json({ value: [sent()] });
  });
  const result = await client.sendOnce({
    ...draft,
    attachments: [{ ...draft.attachments[0], size: 2 * 1024 * 1024, sha256: truncatedHash }],
  }, {
    allowSend: true,
    attachments: [{ name: 'note.txt', mime: 'text/plain', bytes: huge.subarray(0, 2 * 1024 * 1024) }],
  });
  assert.equal(result.uncertain, true);
  assert.equal(result.graphMessageId, undefined);
});

test('send POST is not retried when receipt is uncertain', async () => {
  let posts = 0;
  const client = clientWith(async (url, options = {}) => {
    if (options.method === 'POST') {
      posts += 1;
      return new Response(null, { status: 202 });
    }
    if (url.includes('/attachments')) return json({ value: [] });
    return json({ value: [sent()] });
  });
  await client.sendOnce(draft, { allowSend: true, attachments: [{ name: 'note.txt', mime: 'text/plain', bytes }] });
  await client.reconcile(draft);
  assert.equal(posts, 1);
});

test('text-only drafts still send without an attachments array', async () => {
  const calls = [];
  const plain = { ...draft, attachments: [], draft_id: 'bb22c1bb-768c-4910-9daf-53777ec466ed' };
  const client = clientWith(async (url, options = {}) => {
    calls.push(options);
    if (options.method === 'POST') return new Response(null, { status: 202 });
    return json({
      value: [{
        ...sent(),
        internetMessageHeaders: [{ name: 'x-mi-draft-id', value: plain.draft_id }],
      }],
    });
  });
  const result = await client.sendOnce(plain, { allowSend: true });
  assert.equal(result.graphMessageId, 'immutable-graph-attach');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.message.attachments, undefined);
});
