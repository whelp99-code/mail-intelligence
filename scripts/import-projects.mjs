import { readFileSync, statSync, realpathSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseProjectCsv, previewProjectImport, evaluateProjectImpact } from '../src/application/project-import.js';
import { applyProjectImport } from '../src/application/project-import-command.js';

function digest(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const fd = openSync(path, 'r');
  try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

export function dryRunProjectImport({ csv, snapshot, expectedSha256, mailboxId }) {
  const databasePath = realpathSync(snapshot);
  const csvPath = realpathSync(csv);
  if (databasePath === csvPath || !/^[a-f0-9]{64}$/.test(expectedSha256 || '')
    || !Number.isSafeInteger(mailboxId) || mailboxId < 1) throw new Error('Invalid preview arguments.');
  if ((statSync(databasePath).mode & 0o777) !== 0o600) throw new Error('Snapshot must have mode 0600.');
  if (['-wal', '-journal'].some((suffix) => existsSync(databasePath + suffix)
    && statSync(databasePath + suffix).size > 0)) {
    throw new Error('Snapshot must be a closed standalone backup.');
  }
  const beforeHash = digest(databasePath);
  if (beforeHash !== expectedSha256) throw new Error('Snapshot digest mismatch.');
  const csvHash = digest(csvPath);
  const rows = parseProjectCsv(readFileSync(csvPath, 'utf8'));
  const sidecars = () => ['-wal', '-shm', '-journal'].map((suffix) =>
    existsSync(databasePath + suffix) ? digest(databasePath + suffix) : null);
  const sidecarsBefore = sidecars();
  // immutable=1 prevents even WAL shared-memory writes on this approved closed backup.
  // Never use SQLiteMailStore here:
  // its constructor configures WAL, migrates and changes file permissions.
  const db = new DatabaseSync(`${pathToFileURL(databasePath).href}?mode=ro&immutable=1`, { readOnly: true });
  let report;
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; BEGIN;');
    if (!db.prepare('SELECT id FROM mailboxes WHERE id = ?').get(mailboxId)) throw new Error('Unknown mailbox.');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Snapshot integrity failure.');
    const existing = db.prepare('SELECT * FROM projects WHERE mailbox_id = ? ORDER BY id').all(mailboxId)
      .map((row) => ({ id: row.id, projectKey: row.project_key, name: row.name,
        normalizedName: row.normalized_name, aliases: JSON.parse(row.aliases_json),
        status: row.status, createdBy: row.created_by }));
    const preview = previewProjectImport(rows, existing);
    const totals = db.prepare(`SELECT count(*) AS total,
      COALESCE(sum(deleted_at IS NULL), 0) AS active, COALESCE(sum(deleted_at IS NOT NULL), 0) AS excluded
      FROM messages WHERE mailbox_id = ?`).get(mailboxId);
    const needingPrecision = db.prepare(`SELECT count(*) AS count FROM messages m
      LEFT JOIN precision_classifications pc ON pc.message_id = m.id
      WHERE m.mailbox_id = ? AND m.deleted_at IS NULL
      AND (pc.message_id IS NULL OR pc.updated_at < m.updated_at)`).get(mailboxId).count;
    const messages = db.prepare(`SELECT subject, body_text, body_preview FROM messages
      WHERE mailbox_id = ? AND deleted_at IS NULL ORDER BY id`).iterate(mailboxId);
    const inputs = function* () {
      for (const row of messages) yield { subject: row.subject, body: row.body_text || row.body_preview || '' };
    };
    const impact = evaluateProjectImpact(inputs(), existing, preview.projects);
    report = {
      dryRun: true, csvSha256: csvHash, candidateCount: rows.length, plans: preview.plans,
      denominator: { ...totals, classificationTarget: totals.active, needingPrecision,
        rule: 'mailbox_id = selected mailbox AND deleted_at IS NULL; one messages.id per row; force=true getMessagePage',
        requestedHistoricalCount: 934, historicalCountMatches: totals.active === 934 },
      impact,
      semantics: 'Pure resolveProject before/after registry only, not persisted AI/correction/learning replay. Each target counted once: unchanged first, then changed confirmed/review_required/other_changed. resolutions are separate post-preview totals, not added to impact counts.',
      sideEffects: 'No application registration/reclassification, drafts, status writes, checkpoint, network or external actions.'
    };
    db.exec('ROLLBACK;');
  } finally {
    db.close();
  }
  const afterHash = digest(databasePath);
  if (beforeHash !== afterHash || csvHash !== digest(csvPath)
    || JSON.stringify(sidecarsBefore) !== JSON.stringify(sidecars())) throw new Error('Preview input changed.');
  return { ...report, snapshotSha256Before: beforeHash, snapshotSha256After: afterHash,
    readMode: 'mode=ro&immutable=1; query_only=ON', sidecarsUnchanged: true, unchanged: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      'dry-run': { type: 'boolean' }, csv: { type: 'string' }, snapshot: { type: 'string' },
      'expected-sha256': { type: 'string' }, 'mailbox-id': { type: 'string' },
      apply: { type: 'boolean' }, database: { type: 'string' }, backup: { type: 'string' },
      confirm: { type: 'string' }, 'reclassify-confirm': { type: 'string' }
    } });
    if (Boolean(values['dry-run']) === Boolean(values.apply) || !values.csv) throw new Error('Exactly one mode required.');
    if (values.apply) {
      if (!values.database || !values.backup || values.snapshot || values['expected-sha256']) throw new Error('Apply arguments required.');
      console.log(JSON.stringify(await applyProjectImport({ csv: values.csv, database: values.database,
        mailboxId: Number(values['mailbox-id']), confirm: values.confirm,
        reclassifyConfirm: values['reclassify-confirm'], backupPath: values.backup }), null, 2));
    } else {
      if (!values.snapshot || values.database || values.backup || values.confirm || values['reclassify-confirm']) throw new Error('Dry-run arguments required.');
      console.log(JSON.stringify(dryRunProjectImport({ csv: values.csv, snapshot: values.snapshot,
        expectedSha256: values['expected-sha256'], mailboxId: Number(values['mailbox-id']) }), null, 2));
    }
  } catch (error) {
    // Never print database errors or mail-bearing values to logs.
    console.error(error?.code === 'PROJECT_IMPORT_CONFIRMATION_REJECTED'
      ? `Project import confirmation rejected: ${error.fields.join(',')}` : 'Project import failed.');
    process.exitCode = 1;
  }
}
