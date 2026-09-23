import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import {
  createAttachmentAssetService,
  createSyntheticPassScanner,
  createUnavailableScanner,
} from '../src/application/mail-attachment-assets.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import { digestDriveLinks, normalizeDriveLinks, renderDriveLinks } from '../src/application/drive-links.js';
import { planAttachmentRetention } from '../src/application/attachment-retention.js';
import { createVerifiedBackup, restoreDatabaseFromBackup, verifyRestoredAttachmentAssets } from '../src/storage/backup-restore.js';

const V1_DIGEST = '7598f09dcc86b091cd1947e83a19b8ff86ba7a662de032638178babc14680316';
const KEY = Buffer.alloc(32, 29);
const FILE = 'https://drive.google.com/file/d/abcDEF123-_/view';
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

async function isolatedStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mi-attach-e2e-'));
  const databasePath = join(directory, 'mail-intelligence.sqlite');
  const store = new SQLiteMailStore({ databasePath, migrationsDir });
  const mailbox = store.ensureMailbox({ key: 'me', address: 'me@example.com' });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, store, mailboxId: mailbox.id };
}

test('R18 text-only v1 digest and flags-off attachment API stay compatible', async (t) => {
  const { store, mailboxId } = await isolatedStore(t);
  assert.equal(store.storageStatus().schemaVersion, 7);
  const drafts = new MailSendDrafts(store.db);
  const { draft } = drafts.create(mailboxId, 'ui', {
    request_id: 'e2e-text-1',
    to: ['test@example.com'],
    subject: 'Self test',
    body_text: 'Synthetic fixture only.',
  });
  assert.equal(draft.payload_digest, V1_DIGEST);
  const disabled = createAttachmentAssetService({
    db: store.db,
    getKey: async () => KEY,
    scanner: createUnavailableScanner(),
    attachmentsEnabled: false,
  });
  await assert.rejects(disabled.upload({
    mailboxId,
    source: 'ui',
    requestId: randomUUID(),
    displayName: 'note.txt',
    origin: 'local',
    contentLength: 4,
    body: Readable.from(Buffer.from('abcd')),
  }), { code: 'ATTACHMENTS_DISABLED' });
});

test('R01-R09 synthetic path: upload, bind, link appendix, immutable digest', async (t) => {
  const { store, mailboxId } = await isolatedStore(t);
  const assets = createAttachmentAssetService({
    db: store.db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const bytes = Buffer.from('e2e-bytes', 'utf8');
  const uploaded = await assets.upload({
    mailboxId,
    source: 'ui',
    requestId: randomUUID(),
    displayName: 'note.txt',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  const drafts = new MailSendDrafts(store.db);
  const links = [{ url: FILE, label: 'Spec', access_acknowledged: true }];
  const { draft } = drafts.create(mailboxId, 'ui', {
    request_id: 'e2e-attach-1',
    to: ['test@example.com'],
    subject: 'Self test',
    body_text: 'Synthetic fixture only.',
    attachment_ids: [uploaded.asset.id],
    drive_links: links,
  });
  const normalized = digestDriveLinks(normalizeDriveLinks(links));
  assert.equal(draft.digest_version, 2);
  assert.equal(draft.body_text, `Synthetic fixture only.${renderDriveLinks(normalized)}`);
  assert.equal(draft.attachments[0].sha256, uploaded.asset.sha256);
  assert.throws(() => drafts.create(mailboxId, 'ui', {
    request_id: 'e2e-attach-1',
    to: ['test@example.com'],
    subject: 'Self test',
    body_text: 'Changed',
    attachment_ids: [uploaded.asset.id],
    drive_links: links,
  }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('R16-R17 retention dry-run leaves ciphertext and backup restore keeps SHA-256', async (t) => {
  const { store, directory, mailboxId } = await isolatedStore(t);
  const assets = createAttachmentAssetService({
    db: store.db,
    getKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const bytes = Buffer.from('retain-me', 'utf8');
  const uploaded = await assets.upload({
    mailboxId,
    source: 'ui',
    requestId: randomUUID(),
    displayName: 'keep.txt',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  const planned = planAttachmentRetention(store.db, { now: () => '2026-12-01T00:00:00.000Z', apply: false });
  assert.equal(planned.dryRun, true);
  const backupPath = join(directory, 'backup.sqlite');
  const backup = await createVerifiedBackup({ store, targetPath: backupPath });
  assert.equal(backup.schemaVersion, 7);
  const restoredPath = join(directory, 'restored.sqlite');
  await restoreDatabaseFromBackup({
    backupPath,
    databasePath: restoredPath,
    rollbackDirectory: join(directory, 'rollbacks'),
    confirmServerStopped: true,
  });
  const restored = new DatabaseSync(restoredPath);
  t.after(() => restored.close());
  const verified = verifyRestoredAttachmentAssets({
    databasePath: restoredPath,
    getKey: () => KEY,
  });
  assert.equal(verified.every((item) => item.ok), true);
  const row = restored.prepare('SELECT sha256 FROM mail_attachment_assets WHERE id=?').get(uploaded.asset.id);
  assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
});
