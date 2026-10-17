import test from 'node:test';
import assert from 'node:assert/strict';
import { CwosMailCandidateWriter, loadCwosMailCandidateWriter } from '../src/adapters/cwos-mail-candidate-writer.js';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, symlink, link, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCwosMasterReader } from '../src/adapters/cwos-master-reader.js';

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
  for (const [status, code, lookups] of [
    [302, 'CWOS_CREDENTIAL_REDIRECT', 0],
    [403, 'CWOS_CANDIDATE_DENIED', 0],
    [409, 'CWOS_CANDIDATE_CONFLICT', 1],
  ]) {
    const calls = [];
    const client = new CwosMailCandidateWriter({ ...binding, fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, method: options.method });
      return new Response('', { status });
    } });
    await assert.rejects(client.create(input), { code });
    assert.equal(calls[0].path, '/api/cwos/v2/mail-candidates');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls.length, 1 + lookups);
    if (lookups) assert.match(calls[1].path, /^\/api\/cwos\/v2\/mail-candidates\/mail-candidate-[a-f0-9]{64}$/);
  }
});

function confirmedCandidate(posted, id, patch = {}) {
  return {
    workspaceId: binding.workspaceId,
    runtimeVersion: 6,
    candidate: {
      id,
      providerEventId: posted.providerEventId,
      bodyDigest: posted.bodyDigest,
      subject: posted.subject,
      sourceLocator: posted.sourceLocator,
      mailbox: posted.mailbox,
      provider: posted.provider,
      createdByPrincipalId: binding.principalId,
      status: 'CANDIDATE',
      confirmed: false,
      freshness: 'producer_unverified',
      ...patch,
    },
  };
}

test('a 409 is delivered only after the writer id returns the same candidate', async () => {
  let posted;
  let lookedUp;
  const client = new CwosMailCandidateWriter({ ...binding, fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      posted = JSON.parse(options.body);
      return Response.json({ code: 'CONCURRENT_MODIFICATION' }, { status: 409 });
    }
    lookedUp = url.pathname;
    const id = url.pathname.split('/').at(-1);
    return Response.json(confirmedCandidate(posted, id));
  } });
  const receipt = await client.create(input);
  assert.match(lookedUp, /^\/api\/cwos\/v2\/mail-candidates\/mail-candidate-[a-f0-9]{64}$/);
  assert.equal(receipt.id, lookedUp.split('/').at(-1));
  assert.equal(receipt.runtimeVersion, 6);
  assert.equal(receipt.idempotencyKey, `mail-candidate:${posted.providerEventId.slice('mail-source:'.length)}`);
});

test('a 409 without the candidate, or with different content, stays a conflict', async () => {
  for (const shape of ['absent', 'different', 'foreign-principal', 'list']) {
    let posted;
    const client = new CwosMailCandidateWriter({ ...binding, fetchImpl: async (url, options) => {
      if (options.method === 'POST') {
        posted = JSON.parse(options.body);
        return Response.json({ code: 'CANDIDATE_CONFLICT' }, { status: 409 });
      }
      if (shape === 'absent') return Response.json({ error: 'MAIL_CANDIDATE_NOT_FOUND' }, { status: 404 });
      const id = url.pathname.split('/').at(-1);
      if (shape === 'list') {
        return Response.json({
          workspaceId: binding.workspaceId, count: 1, runtimeVersion: 6,
          candidates: [confirmedCandidate(posted, id).candidate],
        });
      }
      return Response.json(confirmedCandidate(posted, id, shape === 'different'
        ? { bodyDigest: 'e'.repeat(64) }
        : { createdByPrincipalId: 'other-writer' }));
    } });
    await assert.rejects(client.create(input), { code: 'CWOS_CANDIDATE_CONFLICT' });
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
    realpathImpl: async path => path,
    statImpl: async () => ({ isFile: () => true, mode: 0o600 }),
    readFileImpl: async () => binding.apiKey,
  };
  assert.equal((await loadCwosMailCandidateWriter(env, seams)).principalId, binding.principalId);
  await assert.rejects(loadCwosMailCandidateWriter(env, {
    ...seams, statImpl: async () => ({ isFile: () => true, mode: 0o644 }),
  }), { code: 'CWOS_CANDIDATE_CONFIG_INVALID' });
  await assert.rejects(loadCwosMailCandidateWriter({
    ...env, MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: binding.principalId,
  }, seams), { code: 'CWOS_CANDIDATE_READER_CREDENTIAL_REUSE' });
  await assert.rejects(loadCwosMailCandidateWriter({
    ...env, MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: env.MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE,
  }, seams), { code: 'CWOS_CANDIDATE_READER_CREDENTIAL_REUSE' });
});

async function privateLoaderFiles(t) {
  const root = await mkdtemp(join(tmpdir(), 'cwos-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reader = join(root, 'reader.key');
  const writer = join(root, 'writer.key');
  const alias = join(root, 'reader-alias.key');
  const hardLink = join(root, 'reader-hardlink.key');
  await writeFile(reader, 'fixture-reader-key-0123456789abcdef', { mode: 0o600 });
  await writeFile(writer, binding.apiKey, { mode: 0o600 });
  await symlink(reader, alias);
  await link(reader, hardLink);
  const env = {
    MAIL_INTELLIGENCE_CWOS_CANDIDATES_ENABLED: '1',
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_BASE_URL: binding.baseUrl,
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE: writer,
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_PRINCIPAL_ID: binding.principalId,
    MAIL_INTELLIGENCE_CWOS_BASE_URL: binding.baseUrl,
    MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: reader,
    MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: 'fixture-reader',
    MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND: 'service',
    MAIL_INTELLIGENCE_CWOS_PLAN_ID: 'fixture-plan',
    MAIL_INTELLIGENCE_INTAKE_WORKSPACE: binding.workspaceId,
    MAIL_INTELLIGENCE_INTAKE_EXPECTED_EMAIL: binding.mailbox,
  };
  return { root, reader, writer, alias, hardLink, env };
}

test('loader refuses equal trimmed principals before reading keys or sending requests', async (t) => {
  const { env } = await privateLoaderFiles(t);
  let reads = 0;
  let requests = 0;
  for (const [reader, writer] of [
    ['fixture-reader ', 'fixture-reader'],
    ['fixture-reader', ' fixture-reader '],
    [' fixture-reader \t', ' fixture-reader '],
  ]) {
    await assert.rejects(loadCwosMailCandidateWriter({
      ...env,
      MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: reader,
      MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_PRINCIPAL_ID: writer,
    }, {
      readFileImpl: async () => { reads += 1; return binding.apiKey; },
      fetchImpl: async () => { requests += 1; },
    }), { code: 'CWOS_CANDIDATE_READER_CREDENTIAL_REUSE', statusCode: 500 });
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test('loader refuses whitespace slash relative symlink and inode aliases of the reader key', async (t) => {
  const { root, reader, alias, hardLink, env } = await privateLoaderFiles(t);
  let reads = 0;
  let requests = 0;
  for (const [readerPath, writerPath] of [
    [` ${reader} \t`, reader],
    [`${root}//reader.key`, reader],
    [relative(process.cwd(), reader), reader],
    [reader, `${root}//reader.key`],
    [alias, reader],
    [reader, alias],
    [reader, hardLink],
  ]) {
    await assert.rejects(loadCwosMailCandidateWriter({
      ...env,
      MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: readerPath,
      MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE: writerPath,
    }, {
      readFileImpl: async () => { reads += 1; return binding.apiKey; },
      fetchImpl: async () => { requests += 1; },
    }), { code: 'CWOS_CANDIDATE_READER_CREDENTIAL_REUSE', statusCode: 500 });
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test('both loaders read canonical distinct files and use trimmed principals', async (t) => {
  const { root, reader, writer, alias, env } = await privateLoaderFiles(t);
  const writerAlias = join(root, 'writer-alias.key');
  await symlink(writer, writerAlias);
  const paths = [];
  const seams = { readFileImpl: async (path, encoding) => {
    paths.push(path);
    return readFile(path, encoding);
  } };
  const normalizedEnv = {
    ...env,
    MAIL_INTELLIGENCE_CWOS_API_KEY_FILE: ` ${alias} `,
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_KEY_FILE: ` ${root}//writer-alias.key `,
    MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: ' fixture-reader ',
    MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_PRINCIPAL_ID: ` ${binding.principalId} `,
  };
  const loadedReader = await loadCwosMasterReader(normalizedEnv, seams);
  const loadedWriter = await loadCwosMailCandidateWriter(normalizedEnv, seams);
  assert.equal(loadedReader.principalId, 'fixture-reader');
  assert.equal(loadedWriter.principalId, binding.principalId);
  assert.deepEqual(paths, [reader, writer]);
});
