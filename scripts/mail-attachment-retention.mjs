#!/usr/bin/env node
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planAttachmentRetention } from '../src/application/attachment-retention.js';

const apply = process.argv.includes('--apply');
const dbPath = resolve(process.env.MAIL_INTELLIGENCE_DB_PATH || 'data/mail-intelligence.sqlite');
if (apply) {
  console.error('Retention --apply is dry-run blocked in this script until an operator approval sets MAIL_ATTACHMENT_RETENTION_APPLY=1.');
  if (process.env.MAIL_ATTACHMENT_RETENTION_APPLY !== '1') process.exit(2);
}
const db = new DatabaseSync(dbPath);
try {
  const plan = planAttachmentRetention(db, { apply: apply && process.env.MAIL_ATTACHMENT_RETENTION_APPLY === '1' });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} finally {
  db.close();
}
