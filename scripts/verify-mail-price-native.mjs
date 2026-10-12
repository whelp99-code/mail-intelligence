import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { MailWorkIntakeService } from '../src/application/mail-work-intake.js';
import { AttachmentPipeline } from '../src/application/attachment-pipeline.js';
import { canonicalCompanyMemoryBytes } from '../src/application/company-memory-donor.js';
import { PriceAttachmentUploader, PRICE_ATTACHMENT_APPROVAL_DOMAIN } from '../src/adapters/price-attachment-upload.js';

const price = process.argv[2];
assert(price, 'An admitted Price checkout is required');
const root = await mkdtemp(join(tmpdir(), 'mail-fp5-mt-'));
const key = generateKeyPairSync('ed25519');
await writeFile(join(root, 'fixture-approval.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const child = spawn('python', [resolve('scripts/price-native-upload-fixture.py'), root, price], {
  env: {
    ...process.env, HOME: root, XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'), PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: `${price}:/home/jm/.local/lib/python3.14/site-packages`,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const waiting = [];
const buffered = [];
let stderr = '';
let exited = false;
const close = new Promise(resolveClose => child.once('close', code => {
  exited = true;
  for (const waiter of waiting.splice(0)) waiter.reject(new Error(`PRICE_FIXTURE_EXIT_${code}`));
  resolveClose(code);
}));
child.stderr.on('data', data => { stderr += data; });
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const value = JSON.parse(line);
  const waiter = waiting.shift();
  if (waiter) waiter.resolve(value);
  else buffered.push(value);
});
function next() {
  if (buffered.length) return Promise.resolve(buffered.shift());
  assert(!exited, stderr);
  return new Promise((resolveNext, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('PRICE_FIXTURE_TIMEOUT')); }, 10_000);
    waiting.push({
      resolve(value) { clearTimeout(deadline); resolveNext(value); },
      reject(error) { clearTimeout(deadline); reject(error); },
    });
  });
}
async function rpc(value) {
  const result = next();
  child.stdin.write(`${JSON.stringify(value)}\n`);
  return result;
}

let store;
const calls = [];
try {
  const native = await next(); // Fixture-only CSRF stays in this process, never in receipts.
  assert(native.companyId && native.csrfToken);
  const fetchImpl = async (url, options) => {
    const binary = Buffer.isBuffer(options.body);
    const response = await rpc({
      kind: 'http', method: options.method, path: url.pathname + url.search, headers: options.headers,
      body: binary ? options.body.toString('base64') : options.body || null, binary,
    });
    calls.push({ method: options.method, path: url.pathname, status: response.status });
    return new Response(Buffer.from(response.body, 'base64'), { status: response.status, headers: response.headers });
  };
  const raw = Buffer.from(
    '합성 검증용 거래내역\n계좌번호: 123-456-789012\n통화: KRW\n'
    + '거래일시,거래내용,입금액,출금액,거래후잔액\n'
    + '2026-09-01 10:00:00,합성 용역대금,"1,100",0,"1,100"\n'
    + '2026-09-02 10:00:00,합성 장비지급,0,220,880\n합계,,1100,220,\n',
  );
  store = new SQLiteMailStore({ databasePath: join(root, 'mail.sqlite') });
  const mailboxUser = 'mt-fixture@example.invalid';
  const mailbox = store.ensureMailbox({ key: mailboxUser });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  store.applyDeltaPage({
    mailboxId: mailbox.id, folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }), pageIndex: 0,
    items: [normalizeGraphMessage({
      id: 'mt-source', conversationId: 'mt-thread', internetMessageId: '<mt@example.invalid>', changeKey: 'mt-v1',
      subject: 'Explicit synthetic attachment', receivedDateTime: '2026-09-01T03:00:00.000Z',
      from: { emailAddress: { address: 'sender@example.invalid' } },
      body: { contentType: 'text', content: 'Synthetic source attachment only.' }, hasAttachments: true,
      attachments: ['attachment-a', 'attachment-b'].map(id => ({
        id, name: 'synthetic-bank.csv', contentType: 'text/csv', size: raw.length,
        lastModifiedDateTime: '2026-09-01T02:00:00.000Z',
      })),
    })],
    deltaLink: 'https://graph.microsoft.com/fixture/mt',
  });
  const intake = new MailWorkIntakeService({ store });
  const pipeline = new AttachmentPipeline({ db: store.db });
  for (const attachment of store.getAttachmentsForMessage(mailbox.id, 'mt-source')) {
    pipeline.quarantine({ mailboxId: mailbox.id, attachmentId: attachment.databaseId, bytes: raw,
      name: attachment.name, contentType: attachment.contentType });
    pipeline.recordScan({ mailboxId: mailbox.id, attachmentId: attachment.databaseId, state: 'clean',
      scanner: 'explicit-synthetic-fixture-csv', version: '1' });
    pipeline.authorizeExtraction({ mailboxId: mailbox.id, attachmentId: attachment.databaseId,
      parser: 'korean-source-table', version: '4' });
  }
  const uploader = new PriceAttachmentUploader({
    intake, companyId: native.companyId, origin: 'http://127.0.0.1',
    csrfToken: native.csrfToken, approvalKey: key.publicKey, fetchImpl, readBytes: async () => raw,
  });
  const authorize = (proposal, overrides = {}) => {
    const claim = {
      ...proposal, approvedBy: 'human:explicit-mail-fixture', nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), ...overrides,
    };
    return {
      claim,
      signature: sign(null, Buffer.concat([PRICE_ATTACHMENT_APPROVAL_DOMAIN, canonicalCompanyMemoryBytes(claim)]),
        key.privateKey).toString('base64url'),
    };
  };
  const input = { mailboxUser, messageId: 'mt-source', attachmentId: 'attachment-a' };
  const proposal = uploader.proposal(mailboxUser, input.messageId, input.attachmentId);
  const approval = authorize(proposal);
  const uploaded = await uploader.upload({ ...input, approval });
  assert.equal(uploaded.sha256, createHash('sha256').update(raw).digest('hex'));
  const replay = await uploader.upload({ ...input, approval });
  assert.deepEqual(replay, uploaded);
  const duplicated = await uploader.upload({
    ...input, attachmentId: 'attachment-b',
    approval: authorize(uploader.proposal(mailboxUser, input.messageId, 'attachment-b')),
  });
  assert.equal(duplicated.documentId, uploaded.documentId);
  assert.equal(duplicated.blobId, uploaded.blobId);
  assert.notEqual(duplicated.batchId, uploaded.batchId);
  const prefix = `/api/companies/${native.companyId}`;
  const request = async (method, path) => fetchImpl(new URL(path, 'http://127.0.0.1'), {
    method, headers: { 'x-csrf-token': native.csrfToken, 'content-type': 'application/json' },
  });
  const original = await request('GET', `${prefix}/evidence/${uploaded.blobId}/download`);
  assert.equal(original.status, 200);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), raw);
  await rpc({ kind: 'reader' });
  const extraction = await (await request('GET', `${prefix}/documents/${uploaded.documentId}/extraction`)).json();
  assert.equal(extraction.total, 2);
  assert.deepEqual(await (await request('GET', `${prefix}/journals`)).json(), []);
  const beforeDenial = calls.length;
  await assert.rejects(uploader.upload({ ...input, approval: authorize(proposal, { companyId: 'foreign-company' }) }),
    { code: 'PRICE_APPROVAL_SCOPE_MISMATCH' });
  await assert.rejects(uploader.upload({ ...input, approval: { ...approval, signature: 'a'.repeat(86) } }),
    { code: 'PRICE_APPROVAL_SIGNATURE_INVALID' });
  await assert.rejects(uploader.upload({ ...input, approval: authorize(proposal, { expiresAt: '2000-01-01T00:00:00.000Z' }) }),
    { code: 'PRICE_APPROVAL_EXPIRED' });
  assert.equal(calls.length, beforeDenial);
  const foreign = await request('GET', '/api/companies/foreign-company/uploads');
  assert.equal(foreign.status, 404);
  const beforeStale = calls.length;
  uploader.readBytes = async () => {
    const attachment = store.getAttachmentsForMessage(mailbox.id, 'mt-source')[0];
    store.db.prepare('UPDATE attachments SET last_modified_at=? WHERE id=?')
      .run('2026-09-02T02:00:00.000Z', attachment.databaseId);
    return raw;
  };
  await assert.rejects(uploader.upload({ ...input, approval }), { code: 'PRICE_ATTACHMENT_STALE' });
  assert.equal(calls.length, beforeStale);
  const document = await (await request('GET', `${prefix}/documents/${uploaded.documentId}`)).json();
  assert.equal(document.accounting_complete, false);
  const support = await (await request('GET', `${prefix}/support/formats`)).json();
  assert.deepEqual(support.accepted_institution_formats, []);
  const batches = await (await request('GET', `${prefix}/uploads`)).json();
  assert.equal(batches.length, 2);
  assert.equal(new Set(batches.map(batch => batch.files[0].document.id)).size, 1);
  assert.deepEqual(await (await request('GET', `${prefix}/journals`)).json(), []);
  console.log(JSON.stringify({
    level: 'EXPLICIT_FIXTURE_ONLY', sourcePins: native.sourcePins,
    approvedAttachment: uploaded, duplicateAttachment: duplicated,
    nativeSession: 'fixture-owner-issued-by-native-login', replay: 'same-batch-and-document',
    uploadBatches: 2, documents: 1, sourceRecords: extraction.total,
    originalBytes: 'exact', denials: { scopeSignatureExpiry: 3, nativeForeignCompany: 404, staleBeforeFetch: 1 },
    journalCount: 0, accountingComplete: false, acceptedInstitutionFormats: support.accepted_institution_formats,
    authorityLimit: 'upload/source-reader only; no C0 finance report or live service grant',
    httpCalls: calls.length,
  }, null, 2));
  await rpc({ kind: 'close' });
  child.stdin.end();
  assert.equal(await close, 0, stderr);
  assert.match(stderr, /MAIL_PRICE_NATIVE_FIXTURE_CLOSED/);
} finally {
  if (!exited) {
    child.kill('SIGKILL');
    await close;
  }
  lines.close();
  store?.close();
  await rm(root, { recursive: true, force: true });
  await assert.rejects(access(root), { code: 'ENOENT' });
  console.log('MAIL_FP5_MT_LOCAL_CLEANUP_OK');
}
