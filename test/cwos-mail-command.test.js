import test from 'node:test';
import assert from 'node:assert/strict';
import { CwosMailCommandClient, mailSourceDigest } from '../src/adapters/cwos-mail-command.js';

const source = {
  messageId: 'message', receivedAt: '2026-09-01T00:00:00.000Z', revision: 'v1',
  threadId: 'thread', attachments: [{ attachmentId: 'a1', revision: 'attachment-v1' }],
};
const input = {
  workspaceId: 'fixture-workspace', source, mailboxUser: 'fixture@example.invalid',
  message: { subject: 'Fixture', from: 'sender@example.invalid', body: 'Evidence' },
  expectedVersion: 1, assertCurrent: () => {},
};
const config = {
  baseUrl: 'http://127.0.0.1', apiKey: 'fixture-key', workspaceId: input.workspaceId,
  principalId: 'fixture-service', kind: 'service',
};

test('native source key ignores observation time and couples attachment/source revisions', () => {
  assert.equal(mailSourceDigest({ ...source, observedAt: 'one' }), mailSourceDigest({ ...source, observedAt: 'two' }));
  assert.notEqual(mailSourceDigest(source), mailSourceDigest({ ...source, revision: 'v2' }));
  assert.notEqual(mailSourceDigest(source), mailSourceDigest({ ...source, attachments: [] }));
});

test('native source identity binds workspace and mailbox', () => {
  const first = new CwosMailCommandClient(config);
  const second = new CwosMailCommandClient({ ...config, workspaceId: 'other-workspace' });
  const key = first.sourceFields(input.workspaceId, source, input.mailboxUser).sourceEventId;
  assert.notEqual(key, second.sourceFields('other-workspace', source, input.mailboxUser).sourceEventId);
  assert.notEqual(key, first.sourceFields(input.workspaceId, source, 'other@example.invalid').sourceEventId);
});

test('scope, stale source and human handoff deny before HTTP', async () => {
  let calls = 0;
  const client = new CwosMailCommandClient({ ...config, fetchImpl: async () => { calls++; throw new Error('Unexpected HTTP'); } });
  await assert.rejects(client.receive({ ...input, workspaceId: 'foreign' }), { code: 'CWOS_WORKSPACE_NOT_BOUND' });
  await assert.rejects(client.mapWork({ ...input, workItemId: 'work', correctionReason: 'fixture correction' }),
    { code: 'CWOS_HUMAN_HANDOFF_REQUIRED' });
  await assert.rejects(client.receive({ ...input, assertCurrent() {
    throw Object.assign(new Error('INTAKE_SOURCE_CHANGED'), { code: 'INTAKE_SOURCE_CHANGED' });
  } }), { code: 'INTAKE_SOURCE_CHANGED' });
  assert.equal(calls, 0);
});

test('native request keeps received time and refuses a foreign response receipt', async () => {
  const client = new CwosMailCommandClient({
    ...config,
    async fetchImpl(url, options) {
      assert.equal(url.pathname, '/api/cwos/v2/commands');
      const request = JSON.parse(options.body);
      assert.equal(request.command, 'mail.inbox.receive');
      assert.equal(request.payload.receivedAt, source.receivedAt);
      assert.equal(options.headers['x-principal-kind'], 'service');
      assert.equal(Object.hasOwn(options.headers, 'x-step-up'), false);
      return Response.json({
        runtimeVersion: 2, stateHash: 'a'.repeat(64),
        result: { ...request.payload, workspaceId: 'foreign' },
      });
    },
  });
  await assert.rejects(client.receive(input), { code: 'CWOS_RESPONSE_SCOPE_MISMATCH' });
});
