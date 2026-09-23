import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAttachmentAssetService, createSyntheticPassScanner } from '../src/application/mail-attachment-assets.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { createVerifiedBackup, restoreDatabaseFromBackup, verifyRestoredAttachmentAssets } from '../src/storage/backup-restore.js';
import { decryptAttachment, encryptAttachment } from '../src/storage/mail-attachment-crypto.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const KEY = Buffer.alloc(32, 21);

test('restored ready assets decrypt with stored AAD versions and the same SHA-256', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'attach-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'mail.sqlite');
  const store = new SQLiteMailStore({ databasePath, migrationsDir: join(process.cwd(), 'migrations') });
  store.ensureMailbox({ key: 'me' });
  const mailbox = store.getMailbox('me');
  const assets = createAttachmentAssetService({
    db: store.db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const bytes = Buffer.from('backup-bytes', 'utf8');
  const uploaded = await assets.upload({
    mailboxId: mailbox.id,
    source: 'ui',
    requestId: randomUUID(),
    displayName: 'note.txt',
    declaredMime: 'text/plain',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  const backupPath = join(directory, 'backup.sqlite');
  await createVerifiedBackup({ store, targetPath: backupPath });
  store.close();
  const restoredPath = join(directory, 'restored.sqlite');
  await restoreDatabaseFromBackup({
    backupPath,
    databasePath: restoredPath,
    rollbackDirectory: join(directory, 'rollbacks'),
    confirmServerStopped: true,
  });
  const verified = verifyRestoredAttachmentAssets({ databasePath: restoredPath, getKey: () => KEY });
  assert.equal(verified[0].ok, true);
  assert.equal(verified[0].sha256, uploaded.asset.sha256);
  const missing = verifyRestoredAttachmentAssets({ databasePath: restoredPath, getKey: () => null });
  assert.equal(missing[0].reason, 'KEY_MISSING');
  const wrong = verifyRestoredAttachmentAssets({ databasePath: restoredPath, getKey: () => Buffer.alloc(32, 1) });
  assert.equal(wrong[0].ok, false);
});

test('legacy AAD versions restore and decrypt; current constants do not replace them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'attach-aad-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'mail.sqlite');
  const store = new SQLiteMailStore({ databasePath, migrationsDir: join(process.cwd(), 'migrations') });
  store.ensureMailbox({ key: 'me' });
  const mailbox = store.getMailbox('me');
  const bytes = Buffer.from('legacy-aad-bytes', 'utf8');
  const assets = createAttachmentAssetService({
    db: store.db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const uploaded = await assets.upload({
    mailboxId: mailbox.id,
    source: 'ui',
    requestId: randomUUID(),
    displayName: 'legacy.txt',
    declaredMime: 'text/plain',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  const sealed = encryptAttachment(bytes, {
    key: KEY,
    assetId: uploaded.asset.id,
    mailboxId: mailbox.id,
    encryptionAadVersion: 'aad-legacy',
    encryptionPolicyVersion: 'policy-legacy',
  });
  store.db.prepare(`
    UPDATE mail_attachment_assets
    SET ciphertext=?, nonce=?, auth_tag=?, encryption_aad_version=?, encryption_policy_version=?
    WHERE id=?
  `).run(sealed.ciphertext, sealed.nonce, sealed.authTag, 'aad-legacy', 'policy-legacy', uploaded.asset.id);
  const backupPath = join(directory, 'backup.sqlite');
  await createVerifiedBackup({ store, targetPath: backupPath });
  store.close();
  const restoredPath = join(directory, 'restored.sqlite');
  await restoreDatabaseFromBackup({
    backupPath,
    databasePath: restoredPath,
    rollbackDirectory: join(directory, 'rollbacks'),
    confirmServerStopped: true,
  });
  const verified = verifyRestoredAttachmentAssets({ databasePath: restoredPath, getKey: () => KEY });
  assert.equal(verified[0].ok, true);
  const restored = new DatabaseSync(restoredPath);
  t.after(() => restored.close());
  const row = restored.prepare('SELECT * FROM mail_attachment_assets WHERE id=?').get(uploaded.asset.id);
  assert.equal(row.encryption_aad_version, 'aad-legacy');
  assert.equal(row.encryption_policy_version, 'policy-legacy');
  const plaintext = decryptAttachment({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    key: KEY,
    assetId: row.id,
    mailboxId: row.mailbox_id,
    encryptionAadVersion: row.encryption_aad_version,
    encryptionPolicyVersion: row.encryption_policy_version,
  });
  assert.deepEqual(plaintext, bytes);
  assert.throws(() => decryptAttachment({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    key: KEY,
    assetId: row.id,
    mailboxId: row.mailbox_id,
  }));
  const drafts = new MailSendDrafts(restored);
  const created = drafts.create(mailbox.id, 'ui', {
    request_id: 'legacy-aad-draft-1',
    to: ['self@example.com'],
    subject: 'Legacy',
    body_text: 'Synthetic only.',
    attachment_ids: [uploaded.asset.id],
  }).draft;
  restored.prepare('UPDATE mail_attachment_assets SET scan_policy_version=? WHERE id=?').run('scan-policy-old', uploaded.asset.id);
  assert.throws(() => drafts.approve(mailbox.id, created.draft_id, {
    actor: 'session:owner',
    digest: created.payload_digest,
    allowSend: true,
    hasSendScope: true,
  }), { code: 'ASSET_CHANGED' });
});

test('verify:backup:isolated passes against the current synthetic schema, not the operational DB', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'attach-verify-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'mail-intelligence.sqlite');
  const store = new SQLiteMailStore({ databasePath, migrationsDir: join(process.cwd(), 'migrations') });
  const mailbox = store.ensureMailbox({ key: 'me@example.test', address: 'me@example.test' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage({
      id: 'fixture-1',
      changeKey: 'ck-1',
      conversationId: 'conv-1',
      internetMessageId: '<fixture-1@example.test>',
      subject: 'Synthetic backup fixture',
      bodyPreview: 'Synthetic only.',
      body: { contentType: 'text', content: 'Synthetic only.' },
      from: { emailAddress: { address: 'a@example.test', name: 'A' } },
      toRecipients: [{ emailAddress: { address: 'me@example.test', name: 'Me' } }],
      receivedDateTime: '2026-09-10T00:00:00.000Z',
      sentDateTime: '2026-09-10T00:00:00.000Z',
      createdDateTime: '2026-09-10T00:00:00.000Z',
      lastModifiedDateTime: '2026-09-10T00:00:00.000Z',
      parentFolderId: 'inbox',
      isRead: false,
      isDraft: false,
      hasAttachments: false,
    }),
  });
  store.savePrecisionClassification(mailbox.id, 'fixture-1', {
    workState: 'action_required',
    nextActor: 'me',
    priority: 'normal',
    duePrecision: 'none',
    projectResolution: 'unassigned',
    signals: [],
    evidence: {},
    confidence: {},
    reviewReasons: [],
    reviewStatus: 'auto',
    promptVersion: PRECISION_CLASSIFICATION_VERSION,
  });
  const schemaVersion = Number(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version);
  store.close();
  const result = spawnSync(process.execPath, ['scripts/verify-isolated-backup-restore.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MAIL_INTELLIGENCE_DB_PATH: databasePath,
      MAIL_INTELLIGENCE_DATA_DIR: directory,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.isolatedBackupRestore, 'PASS');
  assert.equal(report.schemaVersion, schemaVersion);
  assert.equal(report.liveDatabaseReplaced, false);
});
