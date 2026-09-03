#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createVerifiedBackup,
  restoreDatabaseFromBackup,
  sha256File,
  validateSqliteDatabase,
} from '../src/storage/backup-restore.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';

const databasePath = resolve(process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
const dataDirectory = resolve(process.env.MAIL_INTELLIGENCE_DATA_DIR || 'data');
const backupDirectory = join(dataDirectory, 'backups');
const qaFixTag = PRECISION_CLASSIFICATION_VERSION.match(/qa-fix\d+$/)?.[0] || 'qa-candidate';
const verificationRoot = join(dataDirectory, `${qaFixTag}-isolated-restore`);
mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
chmodSync(backupDirectory, 0o700);
mkdirSync(verificationRoot, { recursive: true, mode: 0o700 });
chmodSync(verificationRoot, 0o700);
const runDirectory = join(verificationRoot, `run-${Date.now()}`);
mkdirSync(runDirectory, { recursive: false, mode: 0o700 });
chmodSync(runDirectory, 0o700);
const backupPath = join(backupDirectory, `${qaFixTag}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
const restoredPath = join(runDirectory, 'restored.sqlite');
const rollbackDirectory = join(runDirectory, 'rollbacks');

function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS active_messages,
        (SELECT COUNT(*) FROM precision_classifications pc
          JOIN messages m ON m.id = pc.message_id
          WHERE m.deleted_at IS NULL) AS active_classifications,
        (SELECT COUNT(*) FROM mail_folders) AS folders,
        (SELECT COUNT(*) FROM precision_corrections) AS corrections,
        (SELECT COUNT(*) FROM backup_manifests) AS backup_manifests
    `).get();
    const versions = db.prepare(`
      SELECT pc.prompt_version, COUNT(*) AS count
      FROM precision_classifications pc
      JOIN messages m ON m.id = pc.message_id
      WHERE m.deleted_at IS NULL
      GROUP BY pc.prompt_version
      ORDER BY count DESC
    `).all().map((item) => ({
      promptVersion: item.prompt_version,
      count: Number(item.count || 0),
    }));
    return {
      activeMessages: Number(row.active_messages || 0),
      activeClassifications: Number(row.active_classifications || 0),
      folders: Number(row.folders || 0),
      corrections: Number(row.corrections || 0),
      backupManifests: Number(row.backup_manifests || 0),
      versions,
    };
  } finally {
    db.close();
  }
}

let store;
try {
  store = new SQLiteMailStore({ databasePath, migrationsDir: resolve('migrations') });
  const backup = await createVerifiedBackup({ store, targetPath: backupPath });
  store.close();
  store = null;

  const restored = await restoreDatabaseFromBackup({
    backupPath,
    databasePath: restoredPath,
    rollbackDirectory,
    confirmServerStopped: true,
  });
  const backupValidation = validateSqliteDatabase(backupPath);
  const restoreValidation = validateSqliteDatabase(restoredPath);
  const backupCounts = counts(backupPath);
  const restoreCounts = counts(restoredPath);
  const backupChecksum = await sha256File(backupPath);
  const restoreChecksum = await sha256File(restoredPath);

  assert.equal(backupValidation.ok, true);
  assert.equal(restoreValidation.ok, true);
  assert.equal(backupValidation.schemaVersion, 4);
  assert.equal(restoreValidation.schemaVersion, 4);
  assert.deepEqual(restoreCounts, backupCounts);
  assert.equal(restoreChecksum, backupChecksum);
  assert.equal(statSync(runDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(restoredPath).mode & 0o777, 0o600);
  assert.equal(backupCounts.activeMessages, backupCounts.activeClassifications);
  assert.deepEqual(backupCounts.versions, [{
    promptVersion: PRECISION_CLASSIFICATION_VERSION,
    count: backupCounts.activeMessages,
  }]);

  console.log(JSON.stringify({
    isolatedBackupRestore: 'PASS',
    backupName: basename(backupPath),
    backupChecksumSha256: backup.checksumSha256,
    restoredChecksumSha256: restored.checksumSha256,
    schemaVersion: restoreValidation.schemaVersion,
    quickCheck: restoreValidation.quickCheck,
    foreignKeyErrors: restoreValidation.foreignKeyErrors.length,
    directoryMode: (statSync(runDirectory).mode & 0o777).toString(8),
    restoredMode: (statSync(restoredPath).mode & 0o777).toString(8),
    counts: restoreCounts,
    liveDatabaseReplaced: false,
  }, null, 2));
} finally {
  store?.close();
  rmSync(runDirectory, { recursive: true, force: true });
}
