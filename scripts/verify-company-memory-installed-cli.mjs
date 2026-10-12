#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import {
  canonicalCompanyMemoryBytes,
  createMailProductDonorPort,
  enqueueMailCompanyMemoryOutbox,
  publishCompanyMemoryDonor,
} from '../src/application/company-memory-donor.js';
import {
  resolveMailCompanyMemorySource,
  runBoundCompanyMemoryDonorTick,
} from '../src/application/company-memory-donor-bind.js';

const [command, sbSource] = process.argv.slice(2);
assert.ok(command && isAbsolute(command) && basename(command) === 'sb-company');
assert.ok(sbSource && isAbsolute(sbSource));
assert.equal(command, join(sbSource, '.venv/bin/sb-company'), 'CLI must belong to the admitted source');
const admitted = [
  ['sb/company_memory_sources.py', '618b6cab6fcf67874fdd5fe0cd3a22994980ffea023ca3c0b9c71b99c12e5424'],
  ['tests/test_company_memory_read_profile.py', '751e44f6d5b1367c42c06532768a8925cc7a6ffe47bdbf111b96ae70d2da5e51'],
];
for (const [path, expected] of admitted) {
  assert.equal(createHash('sha256').update(await readFile(join(sbSource, path))).digest('hex'), expected);
}

const domain = Buffer.from('second-brain/company-memory-authority/v1\0');
const requestDomain = Buffer.from('second-brain/company-memory-request/v1\0');
const context = {
  providerInstanceId: 'provider:mail-fixture',
  workspaceId: '12345678-1234-4234-8234-123456789abc',
  principalId: 'principal:fixture',
  agentId: 'agent:mail-fixture',
  sessionId: 'session:mail-fixture',
  projects: ['project:fixture'],
  policyRevision: 'policy:fixture',
  deletionSequence: 0,
  deletionSetRoot: `sha256:${'a'.repeat(64)}`,
};
const keyId = 'fixture-key:mail';
const root = await mkdtemp(join(tmpdir(), 'mail-fp5-ms-'));
const invocations = [];
const sourceRoot = join(root, 'sources');
const companyRoot = join(root, 'company');
const personalRoot = join(root, 'personal');
const configPath = join(root, 'company-config.json');
const companyDatabase = join(companyRoot, 'company.sqlite');
const keys = generateKeyPairSync('ed25519');
const signer = { keyId, sign: (bytes) => sign(null, bytes, keys.privateKey) };
const requests = [];
let store;
let receipt;

async function invoke(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['--config', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SB_CONFIG: join(root, 'unused-personal.toml') },
    });
    const stdout = [];
    const stderr = [];
    let spawnError;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        spawnError = error;
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      const result = { exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      invocations.push({ exitCode: result.exitCode });
      resolve(result);
    });
    child.stdin.end(request);
  });
}

function countCandidates() {
  if (!existsSync(companyDatabase)) return 0;
  const db = new DatabaseSync(companyDatabase, { readOnly: true });
  try {
    return db.prepare('SELECT count(*) AS n FROM company_memory_candidates').get().n;
  } finally {
    db.close();
  }
}

async function operate(operation, argumentsValue) {
  const now = new Date();
  const digest = `sha256:${createHash('sha256').update(requestDomain)
    .update(canonicalCompanyMemoryBytes({ operation, arguments: argumentsValue })).digest('hex')}`;
  const unsigned = {
    schema_version: 1,
    provider_instance_id: context.providerInstanceId,
    workspace_id: context.workspaceId,
    principal_id: context.principalId,
    agent_id: context.agentId,
    session_id: context.sessionId,
    projects: context.projects,
    policy_revision: context.policyRevision,
    purpose: `company_memory_${operation}`,
    operation,
    request_digest: digest,
    deletion_sequence: context.deletionSequence,
    deletion_set_root: context.deletionSetRoot,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    nonce: `fixture:${operation}:${createHash('sha256').update(argumentsValue.candidate_id).digest('hex')}`,
    signing_key_id: keyId,
  };
  const request = canonicalCompanyMemoryBytes({
    arguments: argumentsValue,
    authority: {
      ...unsigned,
      signature: signer.sign(Buffer.concat([domain, canonicalCompanyMemoryBytes(unsigned)])).toString('base64url'),
    },
  });
  const result = await invoke(request);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  const parsed = JSON.parse(result.stdout.toString());
  assert.equal(parsed.receipt.request_digest, digest);
  assert.equal(parsed.receipt.operation, operation);
  assert.equal(parsed.receipt.workspace_id, context.workspaceId);
  return parsed.receipt.result;
}

try {
  for (const directory of [sourceRoot, companyRoot, personalRoot]) {
    await mkdir(directory, { mode: 0o700 });
  }
  store = new SQLiteMailStore({ databasePath: join(root, 'mail', 'mail.sqlite') });
  const mailbox = store.ensureMailbox({ key: 'fixture@example.invalid' });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  const original = '  Original company fixture.\n';
  const corrected = '  Corrected company fixture.\n';
  for (const [id, content] of [['original', original], ['corrected', corrected]]) {
    store.applyDeltaPage({
      mailboxId: mailbox.id,
      folderId: folder.id,
      syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }),
      pageIndex: 0,
      items: [normalizeGraphMessage({
        id, internetMessageId: `<${id}@example.invalid>`, conversationId: 'fixture-thread',
        body: { contentType: 'text', content }, receivedDateTime: '2026-10-01T00:00:00.000Z',
      })],
      deltaLink: `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?fixture=${id}`,
    });
    store.db.prepare('UPDATE messages SET body_text=? WHERE mailbox_id=? AND graph_id=?')
      .run(content, mailbox.id, id);
    await writeFile(join(sourceRoot, `${id}.txt`), content, { mode: 0o600 });
  }
  const config = {
    schema_version: 1,
    company_database: companyDatabase,
    personal_data_roots: [personalRoot],
    provider_instance_id: context.providerInstanceId,
    workspace_id: context.workspaceId,
    principal_id: context.principalId,
    agent_id: context.agentId,
    session_id: context.sessionId,
    projects: context.projects,
    policy_revision: context.policyRevision,
    deletion_sequence: context.deletionSequence,
    deletion_set_root: context.deletionSetRoot,
    trusted_keys: {
      [keyId]: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    },
    source_profile: {
      schema_version: 1,
      source_roots: [sourceRoot],
      bindings: Object.fromEntries([['original', original], ['corrected', corrected]].map(([id, content]) => [id, {
        path: join(sourceRoot, `${id}.txt`),
        source_system: 'mail',
        source_event_id: `<${id}@example.invalid>`,
        parser_version: 'mail:company-memory:2',
        content_digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      }])),
    },
  };
  const saveConfig = () => writeFile(configPath, canonicalCompanyMemoryBytes(config), { mode: 0o600 });
  await saveConfig();
  const event = enqueueMailCompanyMemoryOutbox(store.db, {
    workspaceId: context.workspaceId, kind: 'INBOX_RECEIVED', provider: 'outlook',
    mailbox: 'fixture@example.invalid', sourceLocator: 'original', sourceEventId: '<original@example.invalid>',
  }, new Date());
  const outbox = createMailProductDonorPort({
    db: store.db,
    resolveSource: (value) => resolveMailCompanyMemorySource(store.db, value),
  });
  const transport = {
    async invoke(request) {
      const result = await invoke(request);
      requests.push({ request: Buffer.from(request), result });
      return result;
    },
  };
  const tick = (overrides = {}) => publishCompanyMemoryDonor({
    context, signer, outbox, transport, now: new Date(), ...overrides,
  });
  const positive = await tick();
  assert.deepEqual(positive.emitted, [event.id], JSON.stringify({
    ...positive,
    cliExit: requests[0]?.result.exitCode,
    cliStdout: requests[0]?.result.stdout.toString(),
    cliStderr: requests[0]?.result.stderr.toString(),
  }));
  const first = requests[0];
  const parsedRequest = JSON.parse(first.request.toString());
  assert.equal(Object.hasOwn(parsedRequest.arguments, 'content'), false);
  assert.equal(parsedRequest.arguments.content_digest, config.source_profile.bindings.original.content_digest);
  const parsedReceipt = JSON.parse(first.result.stdout.toString()).receipt;
  const originalCandidate = parsedRequest.arguments.candidate_id;
  assert.equal(parsedReceipt.candidate_id, originalCandidate);
  assert.equal(parsedReceipt.request_digest, parsedRequest.authority.request_digest);
  const ack = store.db.prepare('SELECT status,version FROM mail_company_memory_outbox WHERE id=?').get(event.id);
  assert.equal(ack.status, 'EMITTED');
  const replay = await invoke(first.request);
  assert.equal(replay.exitCode, 0);
  assert.equal(countCandidates(), 1);
  assert.equal((await tick()).attempted, 0);
  assert.deepEqual(store.db.prepare('SELECT status,version FROM mail_company_memory_outbox WHERE id=?').get(event.id), ack);
  const originalRead = await operate('read', { candidate_id: originalCandidate });
  assert.equal(originalRead.content, original);

  const correctedEvent = enqueueMailCompanyMemoryOutbox(store.db, {
    workspaceId: context.workspaceId, kind: 'WORK_LINK_CORRECTED', provider: 'outlook',
    mailbox: 'fixture@example.invalid', sourceLocator: 'corrected', sourceEventId: '<corrected@example.invalid>',
  }, new Date());
  assert.deepEqual((await tick()).emitted, [correctedEvent.id]);
  const correctedCandidate = JSON.parse(requests.at(-1).request.toString()).arguments.candidate_id;
  assert.notEqual(correctedCandidate, originalCandidate);
  assert.equal((await operate('read', { candidate_id: correctedCandidate })).content, corrected);
  assert.equal((await operate('read', { candidate_id: originalCandidate })).content, original);
  assert.equal(countCandidates(), 2);

  const denied = enqueueMailCompanyMemoryOutbox(store.db, {
    workspaceId: context.workspaceId, kind: 'WORK_LINKED', provider: 'outlook',
    mailbox: 'fixture@example.invalid', sourceLocator: 'original', sourceEventId: '<original@example.invalid>',
  }, new Date());
  const before = store.db.prepare('SELECT status,version FROM mail_company_memory_outbox WHERE id=?').get(denied.id);
  const otherKey = generateKeyPairSync('ed25519');
  const badSignature = await tick({ signer: { keyId, sign: (bytes) => sign(null, bytes, otherKey.privateKey) } });
  assert.deepEqual(badSignature.pending, [denied.id]);
  assert.notEqual(requests.at(-1).result.exitCode, 0);
  assert.deepEqual(store.db.prepare('SELECT status,version FROM mail_company_memory_outbox WHERE id=?').get(denied.id), before);
  assert.equal(countCandidates(), 2);

  config.workspace_id = '22345678-1234-4234-8234-123456789abc';
  await saveConfig();
  assert.deepEqual((await tick()).pending, [denied.id]);
  assert.notEqual(requests.at(-1).result.exitCode, 0);
  assert.equal(countCandidates(), 2);
  config.workspace_id = context.workspaceId;
  config.source_profile.bindings.original.content_digest = `sha256:${'b'.repeat(64)}`;
  await saveConfig();
  assert.deepEqual((await tick()).pending, [denied.id]);
  assert.notEqual(requests.at(-1).result.exitCode, 0);
  assert.deepEqual(store.db.prepare('SELECT status,version FROM mail_company_memory_outbox WHERE id=?').get(denied.id), before);
  assert.equal(countCandidates(), 2);
  assert.deepEqual(await readdir(personalRoot), []);
  assert.equal(await readFile(join(sourceRoot, 'original.txt'), 'utf8'), original);
  assert.equal(await readFile(join(sourceRoot, 'corrected.txt'), 'utf8'), corrected);

  config.source_profile.bindings.original.content_digest = parsedRequest.arguments.content_digest;
  await saveConfig();
  const keyPath = join(root, 'fixture-private.pem');
  const authorityPath = join(root, 'fixture-authority.json');
  await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await writeFile(authorityPath, canonicalCompanyMemoryBytes({ ...context, keyId }), { mode: 0o600 });
  const bound = await runBoundCompanyMemoryDonorTick({
    COMPANY_MEMORY_SB_COMPANY: command,
    COMPANY_MEMORY_SB_COMPANY_CONFIG: configPath,
    COMPANY_MEMORY_SIGNING_KEY_FILE: keyPath,
    COMPANY_MEMORY_AUTHORITY_FILE: authorityPath,
  }, { db: store.db, now: new Date() });
  assert.deepEqual(bound.result.emitted, [denied.id]);
  assert.equal(countCandidates(), 2);
  assert.deepEqual(await readdir(personalRoot), []);
  receipt = {
    sourcePins: admitted,
    request: parsedRequest,
    receipt: parsedReceipt,
    ack,
    cases: { positive: 1, replay: 1, retainedRevisions: 2, denials: 3, boundTick: 1 },
    candidateCount: countCandidates(),
    directCliInvocations: invocations.length,
    boundCliInvocations: bound.result.attempted,
  };
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root), { code: 'ENOENT' });
}
console.log(JSON.stringify(receipt, null, 2));
console.log('MAIL_FP5_MS_LOCAL_CLEANUP_OK');
