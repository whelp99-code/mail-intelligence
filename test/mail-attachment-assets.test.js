import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  decryptAttachment,
  encryptAttachment,
  ENCRYPTION_AAD_VERSION,
  ENCRYPTION_POLICY_VERSION,
} from '../src/storage/mail-attachment-crypto.js';
import {
  ATTACHMENT_LIMITS,
  createAttachmentAssetService,
  createSyntheticPassScanner,
  createUnavailableScanner,
} from '../src/application/mail-attachment-assets.js';

const KEY = Buffer.alloc(32, 9);
const OTHER_KEY = Buffer.alloc(32, 3);

function applySchema(db) {
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
}

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  const service = createAttachmentAssetService({
    db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
    now: () => '2026-09-10T00:00:00.000Z',
    ...options,
  });
  return { db, service };
}

function textBytes(value = 'synthetic attachment fixture') {
  return Buffer.from(value, 'utf8');
}

async function upload(service, overrides = {}) {
  const bytes = overrides.bytes || textBytes();
  const requestId = overrides.requestId || randomUUID();
  const result = await service.upload({
    mailboxId: overrides.mailboxId ?? 1,
    source: overrides.source || 'ui',
    requestId,
    displayName: overrides.displayName || 'note.txt',
    declaredMime: overrides.declaredMime || 'application/octet-stream',
    origin: overrides.origin || 'local',
    contentLength: overrides.contentLength ?? bytes.length,
    body: overrides.body || Readable.from(bytes),
  });
  return { ...result, requestId, bytes };
}

test('migration 006 creates attachment tables, digest columns, and reservation unique index', (t) => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  t.after(() => db.close());
  const tables = db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name').all().map((row) => row.name);
  assert.ok(tables.includes('mail_attachment_assets'));
  assert.ok(tables.includes('mail_draft_attachments'));
  assert.ok(tables.includes('mail_attachment_reservations'));
  const draftCols = db.prepare('PRAGMA table_info(mail_send_drafts)').all().map((row) => row.name);
  assert.ok(draftCols.includes('digest_version'));
  assert.ok(draftCols.includes('links_json'));
  const assetCols = db.prepare('PRAGMA table_info(mail_attachment_assets)').all().map((row) => row.name);
  for (const column of [
    'encryption_aad_version',
    'encryption_policy_version',
    'scan_policy_version',
    'ciphertext',
    'nonce',
    'auth_tag',
  ]) {
    assert.ok(assetCols.includes(column), column);
  }
});

test('encryptAttachment roundtrips and fails closed on tamper or different AAD', () => {
  const plaintext = textBytes('roundtrip-secret');
  const assetId = randomUUID();
  const sealed = encryptAttachment(plaintext, {
    key: KEY,
    assetId,
    mailboxId: 1,
    encryptionAadVersion: ENCRYPTION_AAD_VERSION,
    encryptionPolicyVersion: ENCRYPTION_POLICY_VERSION,
  });
  assert.notEqual(sealed.ciphertext.equals(plaintext), true);
  const opened = decryptAttachment({
    ...sealed,
    key: KEY,
    assetId,
    mailboxId: 1,
  });
  assert.deepEqual(opened, plaintext);

  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptAttachment({
    ...sealed,
    ciphertext: tampered,
    key: KEY,
    assetId,
    mailboxId: 1,
  }));

  assert.throws(() => decryptAttachment({
    ...sealed,
    key: KEY,
    assetId,
    mailboxId: 2,
  }));
  assert.throws(() => decryptAttachment({
    ...sealed,
    key: KEY,
    assetId: randomUUID(),
    mailboxId: 1,
  }));
  assert.throws(() => decryptAttachment({
    ...sealed,
    key: OTHER_KEY,
    assetId,
    mailboxId: 1,
  }));
});

test('ready upload stores only ciphertext and decrypts to the original SHA-256', async (t) => {
  const { db, service } = fixture(t);
  const { asset, bytes } = await upload(service);
  assert.equal(asset.state, 'ready');
  assert.equal(asset.size, bytes.length);
  assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(asset.name, 'note.txt');
  const row = db.prepare('SELECT ciphertext, nonce, auth_tag, encryption_aad_version, encryption_policy_version FROM mail_attachment_assets WHERE id=?').get(asset.id);
  assert.ok(row.ciphertext);
  assert.equal(Buffer.from(row.ciphertext).includes(bytes), false);
  const plain = await service.decryptStored(row, { assetId: asset.id, mailboxId: 1 });
  assert.deepEqual(plain, bytes);
  assert.equal(row.encryption_aad_version, ENCRYPTION_AAD_VERSION);
  assert.equal(row.encryption_policy_version, ENCRYPTION_POLICY_VERSION);
});

test('bounded stream rejects empty bytes and 2MiB+1 without leaving a row', async (t) => {
  const { db, service } = fixture(t);
  await assert.rejects(
    upload(service, { bytes: Buffer.alloc(0), requestId: randomUUID() }),
    { code: 'UNSUPPORTED_FILE', statusCode: 422 },
  );
  const oversized = Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1, 0x61);
  await assert.rejects(
    upload(service, { bytes: oversized, contentLength: oversized.length, requestId: randomUUID() }),
    { code: 'ATTACHMENT_TOO_LARGE', statusCode: 413 },
  );
  await assert.rejects(
    upload(service, {
      bytes: oversized,
      contentLength: undefined,
      body: Readable.from(oversized),
      requestId: randomUUID(),
    }),
    { code: 'ATTACHMENT_TOO_LARGE', statusCode: 413 },
  );
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_assets').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_reservations WHERE released_at IS NULL').get().n, 0);
});

test('exact 2MiB txt upload is accepted', async (t) => {
  const { service } = fixture(t);
  const bytes = Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes, 0x62);
  const { asset } = await upload(service, { bytes, displayName: 'big.txt' });
  assert.equal(asset.size, ATTACHMENT_LIMITS.maxFileBytes);
  assert.equal(asset.state, 'ready');
});

test('request_id replay returns the same asset and conflicts on different bytes', async (t) => {
  const { service } = fixture(t);
  const requestId = randomUUID();
  const first = await upload(service, { requestId, bytes: textBytes('same-bytes') });
  const replay = await upload(service, { requestId, bytes: textBytes('same-bytes') });
  assert.equal(replay.replay, true);
  assert.equal(replay.asset.id, first.asset.id);
  await assert.rejects(
    upload(service, { requestId, bytes: textBytes('different-bytes') }),
    { code: 'REQUEST_CONFLICT', statusCode: 409 },
  );
});

test('mailbox and source ownership hide foreign assets', async (t) => {
  const { service } = fixture(t);
  const { asset } = await upload(service, { mailboxId: 1, source: 'ui' });
  assert.throws(() => service.get(2, asset.id, { source: 'ui' }), { code: 'ASSET_NOT_FOUND', statusCode: 404 });
  assert.throws(() => service.get(1, asset.id, { source: 'grok-bot' }), { code: 'ASSET_NOT_FOUND', statusCode: 404 });
  await assert.rejects(service.getContent(1, asset.id, { actor: 'bot', source: 'ui' }), { code: 'FORBIDDEN', statusCode: 403 });
  const content = await service.getContent(1, asset.id, { actor: 'human', source: 'ui' });
  assert.deepEqual(content.bytes, textBytes());
});

test('quota reservation is released after abort so a later upload can proceed', async (t) => {
  const { db, service } = fixture(t, {
    limits: { ...ATTACHMENT_LIMITS, unlinkedQuotaBytes: 1500, maxFileBytes: 800 },
  });
  await upload(service, { bytes: Buffer.alloc(600, 0x63), displayName: 'a.txt' });
  await assert.rejects(
    upload(service, { bytes: Buffer.alloc(801, 0x64), displayName: 'b.txt' }),
    { code: 'ATTACHMENT_TOO_LARGE' },
  );
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_reservations WHERE released_at IS NULL').get().n, 0);
  const second = await upload(service, { bytes: Buffer.alloc(700, 0x65), displayName: 'c.txt' });
  assert.equal(second.asset.state, 'ready');
  await assert.rejects(
    upload(service, { bytes: Buffer.alloc(400, 0x66), displayName: 'd.txt' }),
    { code: 'ATTACHMENT_QUOTA_EXCEEDED', statusCode: 507 },
  );
});

test('third concurrent upload is rejected while two reservations are held', async (t) => {
  const { service } = fixture(t, {
    limits: { ...ATTACHMENT_LIMITS, maxConcurrentUploads: 2 },
  });
  const hanging = () => new Readable({ read() {} });
  const firstBody = hanging();
  const secondBody = hanging();
  t.after(() => {
    firstBody.destroy();
    secondBody.destroy();
  });
  const first = service.upload({
    mailboxId: 1, source: 'ui', requestId: randomUUID(), displayName: 'one.txt',
    declaredMime: 'text/plain', origin: 'local', contentLength: 4, body: firstBody,
  });
  const second = service.upload({
    mailboxId: 1, source: 'ui', requestId: randomUUID(), displayName: 'two.txt',
    declaredMime: 'text/plain', origin: 'local', contentLength: 4, body: secondBody,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    upload(service, { bytes: textBytes('three'), displayName: 'three.txt' }),
    { code: 'IMPORT_CONCURRENCY_LIMIT', statusCode: 429 },
  );
  first.catch(() => {});
  second.catch(() => {});
});

test('production scanner default is unavailable and leaves no partial asset', async (t) => {
  const { db, service } = fixture(t, { scanner: createUnavailableScanner() });
  await assert.rejects(upload(service), { code: 'SCANNER_UNAVAILABLE', statusCode: 503 });
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_assets').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_reservations WHERE released_at IS NULL').get().n, 0);
});

test('missing attachment key and disabled flag fail closed', async (t) => {
  const disabled = fixture(t, { attachmentsEnabled: false }).service;
  await assert.rejects(upload(disabled), { code: 'ATTACHMENTS_DISABLED', statusCode: 503 });
  const missingKey = fixture(t, {
    getKey: async () => {
      const error = new Error('ENCRYPTION_KEY_MISSING');
      error.code = 'ENCRYPTION_KEY_MISSING';
      throw error;
    },
  }).service;
  await assert.rejects(upload(missingKey), { code: 'ATTACHMENTS_DISABLED', statusCode: 503 });
});

test('path, control, overlong, and unknown-extension names are rejected', async (t) => {
  const { service } = fixture(t);
  for (const displayName of ['../secret.txt', 'a/b.txt', 'evil.exe', 'note.txt\n', `${'x'.repeat(181)}.txt`]) {
    await assert.rejects(
      () => upload(service, { displayName, requestId: randomUUID() }),
      { statusCode: 422 },
      displayName,
    );
  }
  const korean = await upload(service, { displayName: '회의록.txt', bytes: textBytes('한글') });
  assert.equal(korean.asset.name, '회의록.txt');
  const nfc = '회의록.txt'.normalize('NFC');
  const nfd = '회의록.txt'.normalize('NFD');
  const normalized = await upload(service, { displayName: nfd, bytes: textBytes('정규화'), requestId: randomUUID() });
  assert.equal(normalized.asset.name, nfc);
});

test('injected scanner FAIL rejects the upload and leaves no asset', async (t) => {
  const { db, service } = fixture(t, {
    scanner: {
      async scan() {
        return { result: 'FAIL', engine: 'injected-malware', version: 'test-fail' };
      },
    },
  });
  await assert.rejects(upload(service), { code: 'UNSUPPORTED_FILE', statusCode: 422 });
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_assets').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM mail_attachment_reservations WHERE released_at IS NULL').get().n, 0);
});

test('discard expires an unlinked asset owned by the same source', async (t) => {
  const { service } = fixture(t);
  const { asset } = await upload(service);
  const discarded = service.discard(1, asset.id, { source: 'ui' });
  assert.equal(discarded.state, 'expired');
  assert.throws(() => service.get(1, asset.id, { source: 'ui' }), { code: 'ASSET_NOT_FOUND' });
});
