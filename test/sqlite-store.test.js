import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-sqlite-'));
  const databasePath = join(directory, 'mail-intelligence.sqlite');
  const store = new SQLiteMailStore({
    databasePath,
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, store };
}

async function assertPrivateFile(path) {
  try {
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o777, 0o600, `${path} must be owner-only`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function assertPrivateDirectory(path) {
  const metadata = await stat(path);
  assert.equal(metadata.mode & 0o777, 0o700, `${path} must be owner-only directory`);
}

function graphMessage(overrides = {}) {
  return {
    id: 'graph-message-1',
    changeKey: 'change-1',
    conversationId: 'conversation-1',
    internetMessageId: '<message-1@example.com>',
    subject: '선진 HCI 장비 반입 일정 확정',
    from: { emailAddress: { address: 'owner@example.com', name: '김담당' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    ccRecipients: [{ emailAddress: { address: 'engineer@example.com', name: '엔지니어' } }],
    receivedDateTime: '2026-08-28T01:00:00.000Z',
    sentDateTime: '2026-08-28T00:59:00.000Z',
    createdDateTime: '2026-08-28T00:58:00.000Z',
    lastModifiedDateTime: '2026-08-28T01:00:10.000Z',
    importance: 'high',
    inferenceClassification: 'focused',
    flag: { flagStatus: 'flagged' },
    categories: ['HCI', 'Project'],
    isRead: false,
    isDraft: false,
    hasAttachments: true,
    bodyPreview: '장비 반입은 9월 10일 오후 2시로 확정합니다.',
    body: { contentType: 'html', content: '<p>장비 반입은 <strong>9월 10일 오후 2시</strong>로 확정합니다.</p>' },
    webLink: 'https://outlook.office.com/mail/id/1',
    parentFolderId: 'inbox-folder-id',
    attachments: [{
      id: 'attachment-1',
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: '일정표.pdf',
      contentType: 'application/pdf',
      size: 1024,
      isInline: false,
      lastModifiedDateTime: '2026-08-28T01:00:05.000Z',
    }],
    ...overrides,
  };
}

function prepareFolder(store) {
  const mailbox = store.ensureMailbox({ key: 'me', address: 'jm@example.com' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox-folder-id',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  return { mailbox, folder };
}

test('migrations create a healthy v4 precision-intelligence database', async (t) => {
  const { directory, databasePath, store } = await withStore(t);
  const status = store.storageStatus();
  assert.equal(status.ready, true);
  assert.equal(status.schemaVersion, 4);
  assert.deepEqual(status.integrity.quickCheck, ['ok']);
  assert.equal(status.counts.messages, 0);
  await assertPrivateFile(databasePath);
  await assertPrivateFile(`${databasePath}-wal`);
  await assertPrivateFile(`${databasePath}-shm`);
  await assertPrivateDirectory(directory);
});

test('SQLite store rejects an existing data directory with group or other access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-unsafe-sqlite-'));
  try {
    await chmod(directory, 0o755);
    assert.throws(
      () => new SQLiteMailStore({
        databasePath: join(directory, 'mail-intelligence.sqlite'),
        migrationsDir: resolve('migrations'),
      }),
      /owner-only/,
    );
  } finally {
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  }
});

test('delta page atomically stores message, people, thread, recipients and attachment metadata', async (t) => {
  const { store } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  const runId = store.startSyncRun({
    mailboxId: mailbox.id,
    folderId: folder.id,
    runType: 'initial',
  });
  const result = store.applyDeltaPage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    syncRunId: runId,
    pageIndex: 0,
    requestUrl: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta',
    items: [normalizeGraphMessage(graphMessage())],
    deltaLink: 'https://graph.microsoft.com/v1.0/delta-token',
  });
  store.completeSyncRun(runId, folder.id, 'https://graph.microsoft.com/v1.0/delta-token');

  assert.deepEqual(result, { upserts: 1, deletions: 0, items: 1 });
  const messages = store.getRecentMessages(mailbox.id, { limit: 10 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'graph-message-1');
  assert.equal(messages[0].from, 'owner@example.com');
  assert.deepEqual(messages[0].cc, ['engineer@example.com']);
  assert.match(messages[0].body, /9월 10일 오후 2시/);
  assert.equal(messages[0].hasAttachments, true);

  const record = store.getMessageRecord(mailbox.id, 'graph-message-1');
  assert.equal(store.getAttachments(record.id)[0].name, '일정표.pdf');
  const counts = store.counts();
  assert.equal(counts.persons, 3);
  assert.equal(counts.threads, 1);
  assert.equal(counts.messages, 1);
  assert.equal(counts.attachments, 1);

  const sync = store.getSyncStatus(mailbox.id);
  assert.equal(sync.folders[0].has_delta_cursor, 1);
  assert.equal(sync.folders[0].has_resume_cursor, 0);
  assert.equal(sync.latestRuns[0].status, 'completed');
  assert.equal(sync.latestRuns[0].pages_processed, 1);
});

test('same message is idempotent and a new changeKey updates without duplication', async (t) => {
  const { store } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  const first = store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  const same = store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  const changed = store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage({
      changeKey: 'change-2',
      lastModifiedDateTime: '2026-08-28T02:00:00.000Z',
      isRead: true,
      body: { contentType: 'text', content: '변경된 일정 내용' },
    })),
  });

  assert.equal(first.changed, true);
  assert.equal(same.changed, false);
  assert.equal(changed.changed, true);
  assert.equal(store.counts().messages, 1);
  assert.equal(store.getRecentMessages(mailbox.id)[0].isRead, true);
  assert.equal(store.getRecentMessages(mailbox.id)[0].body, '변경된 일정 내용');
});

test('removed delta item creates a tombstone and active queries exclude it', async (t) => {
  const { store } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  const removed = store.markMessageRemoved({
    mailboxId: mailbox.id,
    folderId: folder.id,
    item: normalizeGraphMessage({ id: 'graph-message-1', '@removed': { reason: 'deleted' } }),
  });
  assert.equal(removed.changed, true);
  assert.equal(store.getRecentMessages(mailbox.id).length, 0);
  const all = store.getRecentMessages(mailbox.id, { includeDeleted: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].removedReason, 'deleted');
  assert.ok(all[0].deletedAt);
});

test('FTS5 searches Korean subject and body while excluding deleted messages', async (t) => {
  const { store } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  assert.equal(store.searchMessages(mailbox.id, '장비 일정').length, 1);
  assert.equal(store.searchMessages(mailbox.id, '존재하지않음').length, 0);
  store.markMessageRemoved({
    mailboxId: mailbox.id,
    folderId: folder.id,
    item: normalizeGraphMessage({ id: 'graph-message-1', '@removed': { reason: 'deleted' } }),
  });
  assert.equal(store.searchMessages(mailbox.id, '장비 일정').length, 0);
});

test('feedback is current-state plus append-only events and analysis is version-keyed', async (t) => {
  const { store } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  const feedback = store.saveFeedback(mailbox.id, 'graph-message-1', {
    userStatus: 'waiting',
    reasonCode: 'waiting',
    reasonLabel: '고객 승인 대기',
    note: '보안팀 승인 필요',
    subjectTokens: ['선진', 'HCI'],
  });
  assert.equal(feedback.userStatus, 'waiting');
  assert.equal(store.getFeedbackMap(mailbox.id)['graph-message-1'].note, '보안팀 승인 필요');

  const referenceFeedback = store.saveFeedback(mailbox.id, 'graph-message-1', {
    userStatus: 'reference',
    reasonCode: 'reference',
    reasonLabel: '참고용',
    note: '후속 업무 없음',
  });
  assert.equal(referenceFeedback.userStatus, 'reference');
  assert.equal(store.getFeedbackMap(mailbox.id)['graph-message-1'].userStatus, 'reference');

  const analysis = store.saveAnalysis(mailbox.id, 'graph-message-1', 'provider:model:prompt', {
    source: 'ai',
    provider: 'lmstudio',
    model: 'model-a',
    promptVersion: 'prompt-v1',
    status: 'waiting',
    summary: ['고객 승인 대기'],
    evidenceItems: ['승인 대기 중입니다.'],
    nextActions: [{ actionType: 'monitor', recommendedAction: '승인 여부 확인' }],
  });
  assert.equal(analysis.aiProvider, 'lmstudio');
  assert.deepEqual(analysis.summary, ['고객 승인 대기']);
  assert.equal(store.getAnalysis(mailbox.id, 'graph-message-1', 'provider:model:prompt').status, 'waiting');
});

test('VACUUM INTO backup is independently readable and integrity-checked', async (t) => {
  const { store, directory } = await withStore(t);
  const { mailbox, folder } = prepareFolder(store);
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: normalizeGraphMessage(graphMessage()),
  });
  const backupPath = join(directory, 'backup.sqlite');
  const result = store.backupTo(backupPath);
  assert.ok(result.sizeBytes > 0);
  await assertPrivateFile(backupPath);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(Number(backup.prepare('SELECT COUNT(*) AS count FROM messages').get().count), 1);
    assert.equal(Object.values(backup.prepare('PRAGMA quick_check').get())[0], 'ok');
  } finally {
    backup.close();
  }
});
