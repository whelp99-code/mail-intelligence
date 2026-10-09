import test from 'node:test';
import assert from 'node:assert/strict';
import { CwosMailCandidateWriter, loadCwosMailCandidateWriter } from '../src/adapters/cwos-mail-candidate-writer.js';
import { createHash } from 'node:crypto';

const binding = {
  baseUrl: 'http://127.0.0.1', apiKey: 'fixture-writer-key-0123456789abcdef',
  workspaceId: 'fixture-workspace', principalId: 'fixture-writer', mailbox: 'delegate@example.invalid',
};
const source = { messageId: 'fixture-mail', revision: 'v1', receivedAt: '2026-10-09T00:00:00Z', observedAt: 'first' };
const message = { id: source.messageId, subject: 'Example Project', body: 'Please review Example Project.' };
const input = { workspaceId: binding.workspaceId, source, message, expectedVersion: 4, assertCurrent() {} };

function fixture(mutate = () => {}) {
  const calls = [];
  const client = new CwosMailCandidateWriter({ ...binding, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ path: url.pathname, ...options, body });
    const candidate = {
      id: `mail-candidate-${'a'.repeat(64)}`, ...body,
      status: 'CANDIDATE', confirmed: false, freshness: 'producer_unverified',
      createdByPrincipalId: binding.principalId, createdAt: '2026-10-09T00:00:00Z', version: 1,
    };
    const response = { candidate, runtimeVersion: 5 };
    mutate(response);
    return Response.json(response, { status: 201 });
  } });
  return { client, calls };
}

test('candidate writer sends only scoped create envelope with separate service headers', async () => {
  const { client, calls } = fixture();
  const receipt = await client.create(input);
  assert.equal(receipt.runtimeVersion, 5);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.path, '/api/cwos/v2/mail-candidates');
  assert.equal(call.method, 'POST');
  assert.equal(call.redirect, 'manual');
  assert.equal(call.headers['x-api-key'], binding.apiKey);
  assert.equal(call.headers['x-principal-id'], binding.principalId);
  assert.equal(call.headers['x-principal-kind'], 'service');
  assert.equal(call.headers['x-workspace-id'], binding.workspaceId);
  assert.equal(call.headers['x-step-up'], undefined);
  assert.equal(call.body.bodyDigest, createHash('sha256').update(message.body).digest('hex'));
  assert.equal(call.body.body, undefined);
  assert.deepEqual(Object.keys(call.body).sort(), [
    'bodyDigest', 'expectedVersion', 'mailbox', 'provider', 'providerEventId', 'sourceLocator', 'subject', 'workspaceId',
  ]);
});

test('re-observation preserves event/key while a source revision creates a new candidate occurrence', async () => {
  const { client, calls } = fixture();
  await client.create(input);
  await client.create({ ...input, source: { ...source, observedAt: 'second' } });
  await client.create({ ...input, source: { ...source, revision: 'v2' } });
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
  assert.equal(calls[0].body.providerEventId, calls[1].body.providerEventId);
  assert.notEqual(calls[0].body.providerEventId, calls[2].body.providerEventId);
});

test('scope, source guard and CAS inputs refuse before external write', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.create({ ...input, workspaceId: 'foreign' }), { code: 'CWOS_WORKSPACE_NOT_BOUND' });
  await assert.rejects(client.create({ ...input, expectedVersion: undefined }), { code: 'CWOS_CANDIDATE_INPUT_INVALID' });
  await assert.rejects(client.create({ ...input, assertCurrent: null }), { code: 'CWOS_SOURCE_CHECK_REQUIRED' });
  await assert.rejects(client.create({ ...input, assertCurrent() {
    throw Object.assign(new Error('changed'), { code: 'INTAKE_SOURCE_CHANGED' });
  } }), { code: 'INTAKE_SOURCE_CHANGED' });
  assert.equal(calls.length, 0);
});

test('writer refuses unsafe, foreign and promoted receipts', async () => {
  for (const mutate of [
    value => { value.candidate.workspaceId = 'foreign'; },
    value => { value.candidate.confirmed = true; },
    value => { value.candidate.subject = 'different'; },
    value => { value.candidate.createdByPrincipalId = 'reader'; },
    value => { value.runtimeVersion = 3; },
  ]) {
    const { client } = fixture(mutate);
    await assert.rejects(client.create(input), { code: 'CWOS_CANDIDATE_RECEIPT_MISMATCH' });
  }
});

test('denial, redirect and CAS conflict never fall back to commands or other ports', async () => {
  for (const [status, code] of [[302, 'CWOS_CREDENTIAL_REDIRECT'], [403, 'CWOS_CANDIDATE_DENIED'], [409, 'CWOS_CANDIDATE_CONFLICT']]) {
    const paths = [];
    const client = new CwosMailCandidateWriter({ ...binding, fetchImpl: async url => {
      paths.push(url.pathname);
      return new Response('', { status });
    } });
    await assert.rejects(client.create(input), { code });
    assert.deepEqual(paths, ['/api/cwos/v2/mail-candidates']);
  }
});

test('writer loader is opt-in, private-file-only and distinct from reader authority', async () => {
  assert.equal(await loadCwosMailCandidateWriter({}), null);
  assert.equal(await loadCwosMailCandidateWriter({ MAIL_INTELLIGENCE_CWOS_CANDIDATES_ENABLED: '0' }), null);
  const env = {
    MAIL_INTELLIGENCE_CWOS_CANDIDATES_ENABLED: '1',
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_BASE_URL: binding.baseUrl,
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE: '/fixture/writer.key',
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_PRINCIPAL_ID: binding.principalId,
    MAIL_INTELLIGENCE_INTAKE_WORKSPACE: binding.workspaceId,
    MAIL_INTELLIGENCE_INTAKE_EXPECTED_EMAIL: binding.mailbox,
  };
  const seams = {
    statImpl: async () => ({ isFile: () => true, mode: 0o600 }),
    readFileImpl: async () => binding.apiKey,
  };
  assert.equal((await loadCwosMailCandidateWriter(env, seams)).principalId, binding.principalId);
  await assert.rejects(loadCwosMailCandidateWriter(env, {
    ...seams, statImpl: async () => ({ isFile: () => true, mode: 0o644 }),
  }), { code: 'CWOS_CANDIDATE_CONFIG_INVALID' });
  await assert.rejects(loadCwosMailCandidateWriter({
    ...env, MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: binding.principalId,
  }, seams), { code: 'CWOS_CANDIDATE_CONFIG_INVALID' });
  await assert.rejects(loadCwosMailCandidateWriter({
    ...env, MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: env.MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE,
  }, seams), { code: 'CWOS_CANDIDATE_CONFIG_INVALID' });
});
