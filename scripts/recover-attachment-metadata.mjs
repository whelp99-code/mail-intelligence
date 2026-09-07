#!/usr/bin/env node

import { createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { GraphMailClient } from '../src/adapters/microsoft-graph-mail.js';
import { normalizeGraphAttachment } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const MAX_MESSAGES = 100;

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

function safeHealth(health) {
  return health?.ok === true
    && health?.storage?.ready === true
    && health?.safety?.mode === 'read-only'
    && health?.externalActionsAllowed === false
    && health?.capabilities?.externalAi === false;
}

function candidates(store, mailboxUser) {
  const mailboxWhere = mailboxUser
    ? 'LOWER(COALESCE(b.address, \'\')) = LOWER(?)'
    : 'b.mailbox_key = \'me\'';
  const parameters = mailboxUser ? [mailboxUser] : [];
  return store.db.prepare(`
    SELECT DISTINCT m.id, m.graph_id
    FROM messages m
    JOIN mailboxes b ON b.id = m.mailbox_id
    WHERE m.deleted_at IS NULL AND m.has_attachments = 1 AND ${mailboxWhere}
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
    ORDER BY m.id ASC LIMIT ${MAX_MESSAGES}
  `).all(...parameters);
}

export async function recoverAttachmentMetadata({ store, client, mailboxUser = '', health, createBackup }) {
  if (!safeHealth(health)) fail('UNSAFE_LIVE_CONTRACT');
  const pending = candidates(store, mailboxUser);
  const result = { candidates: pending.length, recovered: 0, failedGet: 0, skippedExisting: 0, backupCreated: 0 };
  if (!pending.length) return result;
  await createBackup();
  result.backupCreated = 1;
  for (const item of pending) {
    try {
      const metadata = await client.fetchAttachmentMetadata({
        mailboxPath: mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : '/me',
        messageId: item.graph_id,
      });
      const attachments = metadata.map(normalizeGraphAttachment);
      if (!attachments.length) {
        result.failedGet += 1;
        continue;
      }
      store.db.exec('BEGIN IMMEDIATE');
      try {
        const active = store.db.prepare('SELECT deleted_at, has_attachments FROM messages WHERE id = ?').get(item.id);
        if (!active || active.deleted_at !== null || active.has_attachments !== 1) {
          result.skippedExisting += 1;
        } else if (store.getAttachments(item.id).length) {
          result.skippedExisting += 1;
        } else {
          store.replaceAttachments(item.id, attachments);
          store.audit('attachment.metadata.recovered', {
            entityType: 'message',
            entityId: item.graph_id,
            payload: { count: attachments.length },
          });
          result.recovered += 1;
        }
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
    } catch {
      result.failedGet += 1;
    }
  }
  return result;
}

async function health(baseUrl, accessKey) {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Authorization: `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`HEALTH_HTTP_${response.status}`);
  return await response.json();
}

async function main() {
  const index = process.argv.indexOf('--source-root');
  const sourceRoot = resolve(index < 0 ? process.cwd() : process.argv[index + 1] || '');
  const dataDirectory = join(sourceRoot, 'data');
  const config = JSON.parse(readFileSync(join(dataDirectory, '.outlook-config.json'), 'utf8'));
  const secrets = decryptSecrets(dataDirectory);
  if (!secrets.accessToken) fail('ACCESS_TOKEN_MISSING');
  const accessKey = readFileSync(join(dataDirectory, '.mail-intelligence-access-key'), 'utf8').trim();
  const baseUrl = 'http://127.0.0.1:3010';
  const liveHealth = await health(baseUrl, accessKey);
  if (!safeHealth(liveHealth)) fail('UNSAFE_LIVE_CONTRACT');
  const recoveryRoot = join(dataDirectory, 'recovery');
  privateDirectory(recoveryRoot);
  const recoveryDirectory = mkdtempSync(join(recoveryRoot, 'attachment-recovery-'));
  chmodSync(recoveryDirectory, 0o700);
  const databasePath = join(dataDirectory, 'mail-intelligence.sqlite');
  const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const backupPath = join(recoveryDirectory, 'before-recovery.sqlite');
  try {
    await backup(sourceDatabase, backupPath);
    chmodSync(backupPath, 0o600);
  } finally {
    sourceDatabase.close();
  }
  const verification = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (verification.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || verification.prepare('PRAGMA foreign_key_check').all().length) fail('BACKUP_INVALID');
  } finally {
    verification.close();
  }
  const store = Object.create(SQLiteMailStore.prototype);
  store.databasePath = resolve(databasePath);
  store.db = new DatabaseSync(store.databasePath);
  store.now = () => new Date().toISOString();
  store.closed = false;
  store.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  try {
    const result = await recoverAttachmentMetadata({
      store,
      client: new GraphMailClient({ accessToken: secrets.accessToken }),
      mailboxUser: String(config.mailboxUser || ''),
      health: liveHealth,
      createBackup: async () => {},
    });
    process.stdout.write(`${JSON.stringify({ command: 'recover-attachment-metadata', status: result.failedGet ? 'INCOMPLETE' : 'COMPLETE', ...result })}\n`);
    if (result.failedGet) process.exitCode = 2;
  } finally {
    store.db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'recover-attachment-metadata', status: 'ERROR', code: String(error?.code || 'RECOVERY_FAILED') })}\n`);
    process.exitCode = 1;
  });
}
