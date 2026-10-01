#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GraphMailClient } from '../src/adapters/microsoft-graph-mail.js';
import { graphItemLacksContent, normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function privateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function decryptSecrets(dataDirectory) {
  const envelope = JSON.parse(readFileSync(join(dataDirectory, '.outlook-secrets.enc.json'), 'utf8'));
  if (envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') fail('SECRETS_INVALID');
  const key = Buffer.from(readFileSync(join(dataDirectory, '.mail-intelligence.key'), 'utf8').trim(), 'base64');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length) fail('SECRETS_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const parsed = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('SECRETS_INVALID');
  return parsed;
}

function blankRows(store) {
  return store.db.prepare(`
    SELECT m.id, m.graph_id, m.mailbox_id, m.folder_id, COALESCE(b.graph_user, '') AS graph_user
    FROM messages m
    JOIN mailboxes b ON b.id = m.mailbox_id
    WHERE m.deleted_at IS NULL AND (m.subject IS NULL OR m.subject = '')
    ORDER BY m.id ASC
  `).all();
}

function backupWithPython(sourcePath, backupPath) {
  const script = `
import sqlite3, sys
src = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
dst = sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
    row = dst.execute('PRAGMA quick_check').fetchone()
    if not row or row[0] != 'ok':
        raise SystemExit('quick_check')
finally:
    src.close()
    dst.close()
`;
  const result = spawnSync('python3', ['-c', script, sourcePath, backupPath], { encoding: 'utf8' });
  if (result.status !== 0) fail('BACKUP_FAILED');
  chmodSync(backupPath, 0o600);
}

export async function backfillBlankMessages({ store, client, apply = false, createBackup = async () => {} }) {
  const pending = blankRows(store);
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    candidates: pending.length,
    restored: 0,
    failed: 0,
    skipped: 0,
    backupCreated: 0,
  };
  if (!apply || !pending.length) return result;
  await createBackup();
  result.backupCreated = 1;
  for (const row of pending) {
    try {
      const current = store.db.prepare(
        'SELECT subject, deleted_at FROM messages WHERE id = ?',
      ).get(row.id);
      if (!current || current.deleted_at || current.subject) {
        result.skipped += 1;
        continue;
      }
      const mailboxPath = row.graph_user
        ? `/users/${encodeURIComponent(row.graph_user)}`
        : '/me';
      const raw = await client.fetchMessage({ mailboxPath, messageId: row.graph_id });
      if (!raw || raw['@removed'] || graphItemLacksContent(raw)) {
        result.failed += 1;
        continue;
      }
      const message = normalizeGraphMessage(raw);
      if (!message.subject) {
        result.failed += 1;
        continue;
      }
      store.upsertNormalizedMessage({
        mailboxId: row.mailbox_id,
        folderId: row.folder_id,
        message,
      });
      result.restored += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const index = process.argv.indexOf('--source-root');
  const sourceRoot = resolve(index < 0 ? process.cwd() : process.argv[index + 1] || '');
  const dataDirectory = join(sourceRoot, 'data');
  const secrets = decryptSecrets(dataDirectory);
  if (!secrets.accessToken) fail('ACCESS_TOKEN_MISSING');
  const databasePath = join(dataDirectory, 'mail-intelligence.sqlite');
  const store = new SQLiteMailStore({
    databasePath,
    migrationsDir: join(sourceRoot, 'migrations'),
  });
  try {
    const recoveryRoot = join(dataDirectory, 'recovery');
    const result = await backfillBlankMessages({
      store,
      client: new GraphMailClient({ accessToken: secrets.accessToken }),
      apply,
      createBackup: async () => {
        privateDirectory(recoveryRoot);
        const recoveryDirectory = mkdtempSync(join(recoveryRoot, 'blank-message-backfill-'));
        chmodSync(recoveryDirectory, 0o700);
        backupWithPython(databasePath, join(recoveryDirectory, 'before-backfill.sqlite'));
      },
    });
    process.stdout.write(`${JSON.stringify({ command: 'backfill-blank-messages', status: result.failed ? 'INCOMPLETE' : 'COMPLETE', ...result })}\n`);
    if (result.failed) process.exitCode = 2;
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'backfill-blank-messages', status: 'ERROR', code: String(error?.code || 'BACKFILL_FAILED') })}\n`);
    process.exitCode = 1;
  });
}
