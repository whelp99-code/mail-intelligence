#!/usr/bin/env node

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

function value(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

const directory = resolve(value('--dir') || process.env.MAIL_INTELLIGENCE_BACKUP_DIR || 'data/backups');
if (existsSync(directory)) {
  const rootMetadata = lstatSync(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Backup inventory directory must be a real directory.');
}
const now = Date.now();
const thirtyDays = 30 * 24 * 60 * 60 * 1000;
const entries = [];
const skipped = [];
try {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      skipped.push({ name: basename(path), reason: metadata.isSymbolicLink() ? 'symlink_not_followed' : 'not_regular_file' });
      continue;
    }
    const details = statSync(path);
    entries.push({ name: basename(path), modifiedAt: details.mtime.toISOString(), sizeBytes: details.size, within30Days: now - details.mtimeMs <= thirtyDays });
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
const keepNewest = new Set(entries.slice(0, 10).map((entry) => entry.name));
const recommendedKeep = entries.filter((entry) => keepNewest.has(entry.name) || entry.within30Days).length;
process.stdout.write(`${JSON.stringify({
  command: 'inventory-backup-retention',
  mode: 'DRY_RUN_NO_DELETE',
  directory,
  regularFiles: entries.length,
  skipped,
  policy: 'Keep verified newest 10 and every backup within 30 days. Protect rollback and evidence artifacts until an operator explicitly reviews them.',
  verification: 'UNKNOWN: this inventory does not validate backup integrity or manifests.',
  recommendedKeep,
  candidatesRequireManualReview: Math.max(0, entries.length - recommendedKeep),
  deletionPerformed: false,
}, null, 2)}\n`);
