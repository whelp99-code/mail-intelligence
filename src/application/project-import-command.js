import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { SQLiteMailStore } from '../storage/sqlite-store.js';
import { sha256File } from '../storage/backup-restore.js';
import { importProjects, parseProjectCsv, previewProjectImport } from './project-import.js';
import { projectReclassificationCount, reclassifyProjectAnalysis } from './project-reclassification.js';

function reject(fields) {
  throw Object.assign(new Error('Project import confirmation rejected.'), {
    code: 'PROJECT_IMPORT_CONFIRMATION_REJECTED', fields,
  });
}

export function validateApplyConfirmation(confirmation, { mailboxId, csvSha256, databasePath, rows }) {
  const expected = `APPLY-PROJECTS mailbox=${mailboxId} csv=${csvSha256.slice(0, 16)} db=${databasePath} rows=${rows}`;
  if (confirmation === expected) return;
  const match = String(confirmation || '').match(/^APPLY-PROJECTS mailbox=(\d+) csv=([a-f0-9]{16}) db=(.+) rows=(\d+)$/);
  if (!match) reject(['format']);
  const supplied = match.slice(1);
  const values = [String(mailboxId), csvSha256.slice(0, 16), databasePath, String(rows)];
  reject(['mailbox', 'csv', 'db', 'rows'].filter((field, i) => supplied[i] !== values[i]));
}

export function validateReclassificationConfirmation(confirmation, mailboxId, count) {
  const expected = `RECLASSIFY-PROJECTS mailbox=${mailboxId} count=${count}`;
  if (confirmation === expected) return;
  const match = String(confirmation || '').match(/^RECLASSIFY-PROJECTS mailbox=(\d+) count=(\d+)$/);
  if (!match) reject(['reclassification_format']);
  reject(['mailbox', 'count'].filter((field, i) => match[i + 1] !== String([mailboxId, count][i])));
}

function assertCurrentSchema(db, migrationsDir) {
  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const names = readdirSync(migrationsDir).filter((name) => /^\d+_.*\.sql$/.test(name));
  if (applied.length !== names.length || names.some((name) => {
    const row = applied.find((item) => item.version === Number(name.split('_')[0]));
    const checksum = createHash('sha256').update(readFileSync(join(migrationsDir, name))).digest('hex');
    return !row || row.name !== name || row.checksum !== checksum;
  })) throw Object.assign(new Error('Current schema required; migrations are not allowed here.'), { code: 'PROJECT_IMPORT_SCHEMA_REQUIRED' });
}

function loadInput(csv) {
  const bytes = readFileSync(csv);
  return { rows: parseProjectCsv(bytes.toString('utf8')), csvSha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function createProjectImportBackup(source, backupPath) {
  if (!isAbsolute(backupPath) || resolve(backupPath) !== backupPath
    || realpathSync(dirname(backupPath)) !== dirname(backupPath)
    || (statSync(dirname(backupPath)).mode & 0o077) !== 0) throw new Error('Private canonical backup directory required.');
  // Exclusive reservation prevents backup API's overwrite behavior from clobbering any existing file.
  const fd = openSync(backupPath, 'wx', 0o600);
  closeSync(fd);
  await backup(source, backupPath);
  const copy = new DatabaseSync(`${pathToFileURL(backupPath).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    copy.exec('PRAGMA query_only = ON;');
    const integrity = copy.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok'
      || copy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Backup integrity failure.');
  } finally {
    copy.close();
  }
  return { backupPath, sha256: await sha256File(backupPath) };
}

export async function applyProjectImport({ csv, database, mailboxId, confirm, reclassifyConfirm, backupPath,
  migrationsDir = resolve('migrations'), onBackup = (receipt) => console.log(JSON.stringify(receipt)) }) {
  if (!Number.isSafeInteger(mailboxId) || mailboxId < 1) reject(['mailbox']);
  if (!isAbsolute(database) || resolve(database) !== database || realpathSync(database) !== database
    || !lstatSync(database).isFile() || (statSync(database).mode & 0o777) !== 0o600) reject(['db']);
  const csvPath = realpathSync(csv);
  if (csvPath === database || backupPath === database || backupPath === csvPath) reject(['db']);
  const input = loadInput(csvPath);
  validateApplyConfirmation(confirm, { mailboxId, csvSha256: input.csvSha256, databasePath: database, rows: input.rows.length });
  if (!reclassifyConfirm) reject(['reclassification_format']);
  const identity = statSync(database);
  const source = new DatabaseSync(database, { readOnly: true });
  let store;
  try {
    source.exec('PRAGMA query_only = ON;');
    const mailbox = source.prepare('SELECT * FROM mailboxes WHERE id = ?').get(mailboxId);
    if (!mailbox) reject(['mailbox']);
    assertCurrentSchema(source, migrationsDir);
    const count = projectReclassificationCount(source, mailboxId);
    validateReclassificationConfirmation(reclassifyConfirm, mailboxId, count);
    const dataVersion = source.prepare('PRAGMA data_version').get().data_version;
    // Preflight conflicts before taking a backup or opening any writable store.
    const existing = source.prepare('SELECT * FROM projects WHERE mailbox_id = ?').all(mailboxId)
      .map((row) => ({ id: row.id, projectKey: row.project_key, name: row.name, normalizedName: row.normalized_name,
        aliases: JSON.parse(row.aliases_json), status: row.status, createdBy: row.created_by }));
    previewProjectImport(input.rows, existing);
    const receipt = await createProjectImportBackup(source, backupPath);
    onBackup(receipt);
    if (await sha256File(receipt.backupPath) !== receipt.sha256) throw new Error('Backup changed.');
    store = new SQLiteMailStore({ databasePath: database, migrationsDir, initialize: false });
    const result = store.transaction(() => {
      const currentIdentity = statSync(database);
      if (realpathSync(database) !== database || currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino) reject(['db']);
      const currentInput = loadInput(csvPath);
      if (currentInput.csvSha256 !== input.csvSha256) reject(['csv']);
      validateApplyConfirmation(confirm, { mailboxId, csvSha256: currentInput.csvSha256, databasePath: database, rows: currentInput.rows.length });
      const currentCount = projectReclassificationCount(store.db, mailboxId);
      validateReclassificationConfirmation(reclassifyConfirm, mailboxId, currentCount);
      if (currentCount !== count || source.prepare('PRAGMA data_version').get().data_version !== dataVersion) {
        throw Object.assign(new Error('Database changed after approval preflight.'), { code: 'PROJECT_IMPORT_DATABASE_DRIFT' });
      }
      // The reported backup must still be the verified file immediately before any writes.
      if (!existsSync(receipt.backupPath) || !lstatSync(receipt.backupPath).isFile()
        || lstatSync(receipt.backupPath).isSymbolicLink()) throw new Error('Backup changed.');
      assertCurrentSchema(store.db, migrationsDir);
      const preview = previewProjectImport(input.rows, store.listProjects(mailboxId, { includeArchived: true }));
      importProjects(store, mailboxId, input.rows);
      const reclassification = reclassifyProjectAnalysis(store, mailbox, currentCount);
      const projects = store.listProjects(mailboxId, { includeArchived: true });
      return { applied: true, candidateCount: input.rows.length,
        operations: { create: preview.plans.filter((plan) => plan.action === 'create').length,
          update: preview.plans.filter((plan) => plan.action === 'update').length,
          unchanged: preview.plans.filter((plan) => plan.action === 'unchanged').length },
        projects: { total: projects.length, active: projects.filter((project) => project.status === 'active').length,
          archived: projects.filter((project) => project.status === 'archived').length }, reclassification };
    });
    return result;
  } finally {
    store?.close();
    source.close();
  }
}
