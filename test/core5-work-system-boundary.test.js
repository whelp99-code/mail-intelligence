import test from 'node:test';
import assert from 'node:assert/strict';
import { CwosWorkSystemAdapter } from '../src/adapters/cwos-work-system.js';

const make = (options = {}) => new CwosWorkSystemAdapter({ db: {}, ...options });

test('missing CWOS connection is not a successful empty customer list', async () => {
  await assert.rejects(make().readMasters({ workspaceId: 'ws-a' }), { code: 'CWOS_CLIENT_UNAVAILABLE' });
});
test('blank workspace is rejected before any upstream call', async () => {
  let calls = 0;
  const adapter = make({ cwosClient: { readMasters: async () => { calls++; return { workspaceId: '', items: [] }; } } });
  await assert.rejects(adapter.readMasters({ workspaceId: '' }), { code: 'CWOS_WORKSPACE_REQUIRED' });
  assert.equal(calls, 0);
});
test('a foreign workspace response is rejected', async () => {
  const adapter = make({ cwosClient: { readMasters: async () => ({ workspaceId: 'ws-other', items: [] }) } });
  await assert.rejects(adapter.readMasters({ workspaceId: 'ws-a' }), { code: 'CWOS_RESPONSE_SCOPE_MISMATCH' });
});
test('malformed upstream data is not converted to an empty success', async () => {
  for (const response of [null, {}, { workspaceId: 'ws-a', items: {} }]) {
    const adapter = make({ cwosClient: { readMasters: async () => response } });
    await assert.rejects(adapter.readMasters({ workspaceId: 'ws-a' }), { code: 'CWOS_RESPONSE_INVALID' });
  }
});
test('valid empty and nonempty responses are preserved', async () => {
  for (const items of [[], [{ id: 'account-1', type: 'account' }]]) {
    const expected = { system: 'cwos', workspaceId: 'ws-a', cursor: 'next', items };
    const adapter = make({ cwosClient: { readMasters: async input => {
      assert.deepEqual(input, { workspaceId: 'ws-a', cursor: 'cursor-1' }); return expected;
    } } });
    assert.equal(await adapter.readMasters({ workspaceId: 'ws-a', cursor: 'cursor-1' }), expected);
  }
});
test('upstream failure is propagated rather than hidden by a Notion fallback', async () => {
  const error = Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_DOWN' });
  let fallbackCalls = 0;
  const adapter = make({ cwosClient: { readMasters: async () => { throw error; } },
    notionReader: { readMasters: async () => { fallbackCalls++; return { workspaceId: 'ws-a', items: [] }; } } });
  await assert.rejects(adapter.readMasters({ workspaceId: 'ws-a' }), candidate => candidate === error);
  assert.equal(fallbackCalls, 0);
});
test('explicit Notion reader remains a read-only scoped projection', async () => {
  const expected = { system: 'notion', workspaceId: 'ws-a', items: [] };
  const adapter = make({ notionReader: { readMasters: async () => expected } });
  assert.equal(await adapter.readMasters({ workspaceId: 'ws-a' }), expected);
  await assert.rejects(adapter.write(), { code: 'CWOS_WRITE_DISABLED' });
});
