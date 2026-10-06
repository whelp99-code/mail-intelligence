import test from 'node:test';
import assert from 'node:assert/strict';
import { CwosMasterReader, cwosMasterReaderConfigFromEnv, loadCwosMasterReader } from '../src/adapters/cwos-master-reader.js';
import { mailSourceDigest } from '../src/adapters/cwos-mail-command.js';

const binding = {
  baseUrl: 'http://127.0.0.1', credential: 'fixture-reader-key-0123456789abcdef',
  workspaceId: 'fixture-workspace', principalId: 'fixture-reader', kind: 'service', planId: 'fixture-plan',
};

function fixture() {
  const state = {
    workspaceId: binding.workspaceId, version: 4, stateHash: 'a'.repeat(64),
    state: {
      workspaceId: binding.workspaceId,
      admin: { workspaces: [{ id: binding.workspaceId, workspaceId: binding.workspaceId, status: 'ACTIVE' }] },
      identity: {
        principals: [{ workspaceId: binding.workspaceId, id: binding.principalId, kind: binding.kind, active: true }],
        memberships: [{ workspaceId: binding.workspaceId, principalId: binding.principalId, status: 'ACTIVE' }],
      },
      normalizedArchiveRefs: [],
    },
  };
  const projection = {
    workspaceId: binding.workspaceId, planId: binding.planId, snapshotId: 'fixture-snapshot',
    snapshotHash: 'sha256:fixture', planHash: 'fnv1a32:fixture',
    sourceObservedAt: '2026-10-06T00:00:00.000Z', planVersion: 1,
    authority: 'ARCHIVE_PROJECTION_ONLY',
    accounts: [{ workspace_id: binding.workspaceId, id: 'account-fixture', name: 'Example Company', kinds: ['customer'], status: 'active' }],
    engagements: [{ workspace_id: binding.workspaceId, id: 'engagement-fixture', name: 'Example Project', engagement_type: 'opportunity', account_id: 'account-fixture' }],
    financialItems: [],
  };
  const calls = [];
  const reader = new CwosMasterReader({ ...binding, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, ...options });
    return Response.json(url.pathname.endsWith('/state') ? state : projection);
  } });
  return { reader, state, projection, calls };
}

test('v2 reader uses machine headers and returns only unconfirmed archive candidates', async () => {
  const { reader, calls } = fixture();
  const result = await reader.readMasters({ workspaceId: binding.workspaceId });
  assert.deepEqual(calls.map(c => c.path), ['/api/cwos/v2/state', '/api/cwos/v2/normalized-projections/fixture-plan']);
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.headers['x-api-key'], binding.credential);
    assert.equal(call.headers['x-principal-id'], binding.principalId);
    assert.equal(call.headers['x-principal-kind'], 'service');
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.headers['x-step-up'], undefined);
  }
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.status, 'candidate');
    assert.equal(item.approved, false);
    assert.equal(item.nativeWork, false);
    assert.equal(item.source.authority, 'ARCHIVE_PROJECTION_ONLY');
    assert.equal(item.source.recordKind, 'ARCHIVE_REFERENCES');
    assert.equal(item.source.planId, binding.planId);
  }
  assert.equal(result.provenance.atomicSnapshot, false);
  assert.equal(result.items[1].relatedAccount.externalId, 'account-fixture');
});

test('v2 reader refuses caller workspace, principal and cursor mismatch before fetch', async () => {
  const { reader, calls } = fixture();
  await assert.rejects(reader.readMasters({ workspaceId: 'foreign' }), { code: 'CWOS_WORKSPACE_NOT_BOUND' });
  await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId, principalId: 'foreign' }), { code: 'CWOS_PRINCIPAL_NOT_BOUND' });
  await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId, cursor: 'partial' }), { code: 'CWOS_MASTERS_INCOMPLETE' });
  assert.equal(calls.length, 0);
});

test('v2 reader requires active matching machine principal and membership before projection fetch', async () => {
  for (const mutate of [
    value => { value.workspaceId = 'foreign'; },
    value => { value.state.workspaceId = 'foreign'; },
    value => { value.state.identity.principals[0].kind = 'human'; },
    value => { value.state.identity.principals[0].active = false; },
    value => { value.state.identity.memberships[0].status = 'SUSPENDED'; },
    value => { value.state.admin.workspaces[0].status = 'SUSPENDED'; },
  ]) {
    const { reader, state, calls } = fixture();
    mutate(state);
    await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId }), { code: 'CWOS_RESPONSE_SCOPE_MISMATCH' });
    assert.equal(calls.length, 1);
  }
});

test('v2 reader refuses projection plan, authority, workspace and row scope mismatches', async () => {
  for (const [mutate, code] of [
    [value => { value.planId = 'foreign'; }, 'CWOS_RESPONSE_INVALID'],
    [value => { value.authority = 'NATIVE_WORK'; }, 'CWOS_RESPONSE_INVALID'],
    [value => { value.workspaceId = 'foreign'; }, 'CWOS_RESPONSE_SCOPE_MISMATCH'],
    [value => { value.accounts[0].workspace_id = 'foreign'; }, 'CWOS_RESPONSE_SCOPE_MISMATCH'],
    [value => { value.planVersion = 0; }, 'CWOS_RESPONSE_INVALID'],
  ]) {
    const { reader, projection } = fixture();
    mutate(projection);
    await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId }), { code });
  }
});

test('v2 reader cannot promote an approved or stale native archive reference', async () => {
  for (const change of [{ approved: true }, { planVersion: 2 }, { planHash: 'foreign' }, { workspaceId: 'foreign' }, { sourceDigest: 'f'.repeat(64) }]) {
    const { reader, state, projection } = fixture();
    state.state.normalizedArchiveRefs = [{
      workspaceId: binding.workspaceId, planId: binding.planId, approved: false,
      planVersion: 1, snapshotHash: projection.snapshotHash, planHash: projection.planHash,
      sourceDigest: mailSourceDigest(projection), ...change,
    }];
    await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId }), { code: 'CWOS_ARCHIVE_REFERENCE_MISMATCH' });
  }
});

test('v2 reader retains older archive references without mistaking them for the current revision', async () => {
  const { reader, state, projection } = fixture();
  projection.planVersion = 2;
  state.state.normalizedArchiveRefs = [{
    workspaceId: binding.workspaceId, planId: binding.planId, approved: false,
    planVersion: 1, snapshotHash: 'prior-snapshot', planHash: 'prior-plan', sourceDigest: 'f'.repeat(64),
  }, {
    workspaceId: binding.workspaceId, planId: binding.planId, approved: false,
    planVersion: 2, snapshotHash: projection.snapshotHash, planHash: projection.planHash,
    sourceDigest: mailSourceDigest(projection),
  }];
  const before = structuredClone(state);
  const result = await reader.readMasters({ workspaceId: binding.workspaceId });
  assert.equal(result.provenance.planVersion, 2);
  assert.deepEqual(state, before);
});

test('v2 reader never follows credentials on redirects or provider denial', async () => {
  for (const [response, code] of [
    [new Response('', { status: 302, headers: { location: 'https://foreign.invalid' } }), 'CWOS_CREDENTIAL_REDIRECT'],
    [new Response('', { status: 403 }), 'CWOS_UNAUTHENTICATED'],
    [new Response('', { status: 500 }), 'CWOS_PROVIDER_HTTP'],
  ]) {
    const reader = new CwosMasterReader({ ...binding, fetchImpl: async () => response });
    await assert.rejects(reader.readMasters({ workspaceId: binding.workspaceId }), { code });
  }
});

test('v2 reader requires explicit actor and plan config and private credential file', async () => {
  assert.equal(cwosMasterReaderConfigFromEnv({}), null);
  const env = {
    MAIL_INTELLIGENCE_CWOS_BASE_URL: binding.baseUrl,
    MAIL_INTELLIGENCE_CWOS_API_KEY: binding.credential,
    MAIL_INTELLIGENCE_INTAKE_WORKSPACE: binding.workspaceId,
    MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: binding.principalId,
    MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND: binding.kind,
    MAIL_INTELLIGENCE_CWOS_PLAN_ID: binding.planId,
  };
  for (const key of ['MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID', 'MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND', 'MAIL_INTELLIGENCE_CWOS_PLAN_ID']) {
    assert.throws(() => cwosMasterReaderConfigFromEnv({ ...env, [key]: '' }), { code: 'CWOS_READER_CONFIG_INVALID' });
  }
  assert.throws(() => cwosMasterReaderConfigFromEnv({ ...env, MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND: 'human' }), { code: 'CWOS_READER_CONFIG_INVALID' });
  await assert.rejects(loadCwosMasterReader({ ...env, MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: '/fixture/key' }, {
    statImpl: async () => ({ isFile: () => true, mode: 0o644 }),
  }), { code: 'CWOS_READER_CONFIG_INVALID' });
  const loaded = await loadCwosMasterReader({ ...env, MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: '/fixture/key' }, {
    statImpl: async () => ({ isFile: () => true, mode: 0o600 }),
    readFileImpl: async () => binding.credential,
  });
  assert.equal(loaded.planId, binding.planId);
});
