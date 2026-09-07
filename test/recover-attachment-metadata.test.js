import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { recoverAttachmentMetadata } from '../scripts/recover-attachment-metadata.mjs';

const safeHealth = {
  ok: true,
  storage: { ready: true },
  safety: { mode: 'read-only' },
  externalActionsAllowed: false,
  capabilities: { externalAi: false },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-recovery-'));
  const store = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite'), migrationsDir: resolve('migrations') });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', displayName: 'Inbox' });
  const message = normalizeGraphMessage({
    id: 'attachment-message', changeKey: 'change-1', conversationId: 'thread-1', subject: 'Attachment',
    from: { emailAddress: { address: 'sender@example.test', name: 'Sender' } },
    receivedDateTime: '2026-09-07T00:00:00.000Z', bodyPreview: 'Body',
    body: { contentType: 'text', content: 'Body' }, parentFolderId: 'inbox', hasAttachments: true,
  });
  const saved = store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message });
  return { store, message, saved };
}

test('recovery backs up then stores fetched metadata and is idempotent', async (t) => {
  const { store, message, saved } = await fixture(t);
  let fetches = 0;
  let backups = 0;
  const client = {
    async fetchAttachmentMetadata({ messageId }) {
      fetches += 1;
      assert.equal(messageId, message.graphId);
      return [{ id: 'attachment-1', name: 'safe.pdf', contentType: 'application/pdf', size: 12, isInline: false, lastModifiedDateTime: '2026-09-07T00:00:00.000Z' }];
    },
  };
  const first = await recoverAttachmentMetadata({ store, client, health: safeHealth, createBackup: async () => { backups += 1; } });
  assert.deepEqual(first, { candidates: 1, recovered: 1, failedGet: 0, skippedExisting: 0, backupCreated: 1 });
  assert.equal(fetches, 1);
  assert.equal(backups, 1);
  assert.equal(store.getAttachments(saved.id).length, 1);
  assert.deepEqual(store.latestAuditEvent('attachment.metadata.recovered', { entityType: 'message', entityId: message.graphId }).payload, { count: 1 });
  const second = await recoverAttachmentMetadata({ store, client, health: safeHealth, createBackup: async () => { backups += 1; } });
  assert.deepEqual(second, { candidates: 0, recovered: 0, failedGet: 0, skippedExisting: 0, backupCreated: 0 });
  assert.equal(fetches, 1);
  assert.equal(backups, 1);
});

test('failed Graph GET preserves missing attachment state and does not record recovery', async (t) => {
  const { store, message, saved } = await fixture(t);
  const result = await recoverAttachmentMetadata({
    store,
    client: { async fetchAttachmentMetadata() { throw new Error('remote body token=secret'); } },
    health: safeHealth,
    createBackup: async () => {},
  });
  assert.deepEqual(result, { candidates: 1, recovered: 0, failedGet: 1, skippedExisting: 0, backupCreated: 1 });
  assert.equal(store.getAttachments(saved.id).length, 0);
  assert.equal(store.latestAuditEvent('attachment.metadata.recovered', { entityType: 'message', entityId: message.graphId }), null);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('unsafe health performs no backup, fetch, or database writes', async (t) => {
  const { store, message, saved } = await fixture(t);
  let fetches = 0;
  let backups = 0;
  await assert.rejects(() => recoverAttachmentMetadata({
    store,
    client: { async fetchAttachmentMetadata() { fetches += 1; return []; } },
    health: { ...safeHealth, externalActionsAllowed: true },
    createBackup: async () => { backups += 1; },
  }), { code: 'UNSAFE_LIVE_CONTRACT' });
  assert.equal(fetches, 0);
  assert.equal(backups, 0);
  assert.equal(store.getAttachments(saved.id).length, 0);
  assert.equal(store.latestAuditEvent('attachment.metadata.recovered', { entityType: 'message', entityId: message.graphId }), null);
});
