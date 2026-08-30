import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import {
  createVerifiedBackup,
  restoreDatabaseFromBackup,
  validateSqliteDatabase,
} from '../src/storage/backup-restore.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function graphMessage(subject, changeKey) {
  return normalizeGraphMessage({
    id: 'restore-message-1',
    changeKey,
    conversationId: 'restore-thread-1',
    subject,
    from: { emailAddress: { address: 'owner@example.com', name: 'Owner' } },
    receivedDateTime: '2026-08-28T01:00:00.000Z',
    lastModifiedDateTime: '2026-08-28T01:00:00.000Z',
    bodyPreview: subject,
    body: { contentType: 'text', content: subject },
    parentFolderId: 'inbox',
  });
}

function openStore(databasePath) {
  return new SQLiteMailStore({
    databasePath,
    migrationsDir: resolve('migrations'),
  });
}

function upsert(store, subject, changeKey) {
  const mailbox = store.ensureMailbox({ key: 'me' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage(subject, changeKey),
  });
  return mailbox;
}

test('verified backup records a manifest and restore atomically replaces the live database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-backup-'));
  const databasePath = join(directory, 'mail-intelligence.sqlite');
  const backupDirectory = join(directory, 'backups');
  const backupPath = join(backupDirectory, 'baseline.sqlite');
  const rollbackDirectory = join(backupDirectory, 'restore-rollbacks');
  let store = openStore(databasePath);

  try {
    let mailbox = upsert(store, '백업 기준 상태', 'change-1');
    const backup = await createVerifiedBackup({ store, targetPath: backupPath });
    assert.equal(backup.validation.ok, true);
    assert.equal(backup.schemaVersion, 4);
    assert.match(backup.checksumSha256, /^[a-f0-9]{64}$/);
    assert.equal(store.listBackupManifests().length, 1);
    assert.equal(store.listBackupManifests()[0].backupName, 'baseline.sqlite');

    mailbox = upsert(store, '백업 이후 변경 상태', 'change-2');
    assert.equal(store.getRecentMessages(mailbox.id)[0].subject, '백업 이후 변경 상태');
    store.close();
    store = null;

    await assert.rejects(
      restoreDatabaseFromBackup({ backupPath, databasePath }),
      /confirmServerStopped=true/,
    );

    const restored = await restoreDatabaseFromBackup({
      backupPath,
      databasePath,
      rollbackDirectory,
      confirmServerStopped: true,
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.validation.ok, true);
    assert.ok(restored.rollbackPath);
    await access(restored.rollbackPath);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(restored.rollbackPath)).mode & 0o777, 0o600);
    assert.equal(validateSqliteDatabase(databasePath).ok, true);
    assert.equal(validateSqliteDatabase(restored.rollbackPath).ok, true);

    store = openStore(databasePath);
    mailbox = store.getMailbox('me');
    assert.equal(store.getRecentMessages(mailbox.id)[0].subject, '백업 기준 상태');
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
