#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';
import {
  PENDING_APPROVALS_PATH,
  runReplyDraftPipeline,
} from '../src/application/reply-draft-pipeline.js';
import { resolveStoragePaths } from '../src/storage/storage-paths.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || '';
}

const dryRun = process.argv.includes('--dry-run');
const since = arg('--since') || new Date(Date.now() - 86_400_000).toISOString();
const paths = resolveStoragePaths({ env: process.env });
const dbPath = arg('--db') || paths.databasePath;
const db = new DatabaseSync(dbPath, { readOnly: dryRun, timeout: 5_000 });
const drafts = dryRun ? null : new MailSendDrafts(db);
const summary = runReplyDraftPipeline({
  db,
  drafts,
  since,
  dryRun,
  queuePath: arg('--queue') || PENDING_APPROVALS_PATH,
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
db.close();
