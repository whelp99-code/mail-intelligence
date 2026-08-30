import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function ensurePrivateDirectorySync(directoryPath) {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    chmodSync(directoryPath, 0o700);
    return;
  }
  const metadata = lstatSync(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Backup directory must be a real directory: ${directoryPath}`);
  }
  const mode = metadata.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Backup directory must be owner-only (0700): ${directoryPath}`);
  }
}

function assertRegularDatabaseFile(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

export function validateSqliteDatabase(databasePath) {
  const target = resolve(databasePath);
  assertRegularDatabaseFile(target, 'SQLite database');
  const database = new DatabaseSync(target, { readOnly: true });
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    const quickCheck = database.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
    const migration = database.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM schema_migrations
    `).get();
    const ok = quickCheck.length === 1 && quickCheck[0] === 'ok' && foreignKeyErrors.length === 0;
    return {
      ok,
      path: target,
      sizeBytes: statSync(target).size,
      schemaVersion: Number(migration?.version || 0),
      quickCheck,
      foreignKeyErrors,
    };
  } finally {
    database.close();
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

export async function createVerifiedBackup({ store, targetPath }) {
  if (!store) throw new Error('store is required.');
  const target = resolve(targetPath);
  ensurePrivateDirectorySync(dirname(target));
  const created = store.backupTo(target);
  const validation = validateSqliteDatabase(target);
  if (!validation.ok) throw new Error('Created backup failed integrity verification.');
  const checksumSha256 = await sha256File(target);
  const status = store.storageStatus();
  const manifest = store.recordBackupManifest({
    backupName: basename(target),
    checksumSha256,
    sizeBytes: created.sizeBytes,
    schemaVersion: validation.schemaVersion,
    recordCounts: status.counts,
    integrity: {
      quickCheck: validation.quickCheck,
      foreignKeyErrors: validation.foreignKeyErrors,
    },
    createdAt: created.createdAt,
    verifiedAt: new Date().toISOString(),
  });
  store.audit('storage.backup.completed', {
    entityType: 'backup',
    entityId: basename(target),
    payload: {
      checksumSha256,
      sizeBytes: created.sizeBytes,
      schemaVersion: validation.schemaVersion,
    },
  });
  return {
    ...created,
    checksumSha256,
    schemaVersion: validation.schemaVersion,
    validation,
    manifest,
  };
}

export async function restoreDatabaseFromBackup({
  backupPath,
  databasePath,
  rollbackDirectory = join(dirname(resolve(databasePath)), 'restore-rollbacks'),
  confirmServerStopped = false,
}) {
  if (!confirmServerStopped) {
    throw new Error('Database restore requires confirmServerStopped=true after stopping Mail Intelligence.');
  }
  const source = resolve(backupPath);
  const target = resolve(databasePath);
  if (!isAbsolute(backupPath) || !isAbsolute(databasePath)) {
    throw new Error('Backup and database paths must be absolute.');
  }
  if (source === target) throw new Error('Backup path must differ from the live database path.');
  const sourceValidation = validateSqliteDatabase(source);
  if (!sourceValidation.ok) throw new Error('Backup database failed integrity verification.');
  ensurePrivateDirectorySync(dirname(target));
  const rollbackRoot = resolve(rollbackDirectory);
  ensurePrivateDirectorySync(rollbackRoot);

  const token = `${Date.now()}-${randomUUID()}`;
  const temporaryPath = `${target}.restore-${token}.tmp`;
  const rollbackPath = join(rollbackRoot, `${basename(target)}.${token}.rollback`);
  let movedLiveDatabase = false;

  try {
    copyFileSync(source, temporaryPath);
    chmodSync(temporaryPath, 0o600);
    const temporaryValidation = validateSqliteDatabase(temporaryPath);
    if (!temporaryValidation.ok) throw new Error('Temporary restored database failed integrity verification.');

    for (const sidecar of [`${target}-wal`, `${target}-shm`]) rmSync(sidecar, { force: true });
    if (existsSync(target)) {
      assertRegularDatabaseFile(target, 'Live SQLite database');
      renameSync(target, rollbackPath);
      chmodSync(rollbackPath, 0o600);
      movedLiveDatabase = true;
    }
    renameSync(temporaryPath, target);
    chmodSync(target, 0o600);
    const finalValidation = validateSqliteDatabase(target);
    if (!finalValidation.ok) throw new Error('Restored live database failed integrity verification.');
    return {
      restored: true,
      databasePath: target,
      backupPath: source,
      rollbackPath: movedLiveDatabase ? rollbackPath : null,
      checksumSha256: await sha256File(target),
      validation: finalValidation,
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (movedLiveDatabase && !existsSync(target) && existsSync(rollbackPath)) {
      renameSync(rollbackPath, target);
      chmodSync(target, 0o600);
    }
    throw error;
  }
}
