import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createNotionWorkSystem } from '../src/adapters/notion-work-system.js';
import { WorkLinkService } from '../src/application/work-links.js';
import { workLinkProjectionAgreement } from '../src/domain/work-link-projection.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function graphMessage(id, subject, body, overrides = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { address: 'customer@example.com', name: '고객 담당자' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    receivedDateTime: '2026-09-11T00:00:00.000Z',
    sentDateTime: '2026-09-11T00:00:00.000Z',
    createdDateTime: '2026-09-11T00:00:00.000Z',
    lastModifiedDateTime: '2026-09-11T00:00:00.000Z',
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
    parentFolderId: 'inbox',
    ...overrides,
  });
}

async function withStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-worklinks-refresh-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail-intelligence.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function snapshot() {
  return {
    workspaceId: 'syn-workspace-jm-business-os',
    snapshotId: 'syn-snapshot-refresh',
    snapshotHash: 'sha256:synthetic-not-production',
    capturedAt: '2026-09-11T00:00:00Z',
    readOnlySource: true,
    accounts: [],
    projects: [{
      sourceId: 'syn-project-sunjin-hci',
      properties: {
        '프로젝트명(Title)': '선진엔지니어링 HCI 구축',
        프로젝트ID: 'PRJ-2026-001',
        '별칭': ['선진 HCI'],
      },
    }],
    activities: [],
    finance: [],
  };
}

function seedMany(store, count, { subject = '[선진 HCI] bulk', start = 0 } = {}) {
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.transaction(() => {
    for (let index = start; index < start + count; index += 1) {
      store.upsertNormalizedMessage({
        mailboxId: mailbox.id,
        folderId: folder.id,
        message: graphMessage(`syn-mail-bulk-${index}`, `${subject} ${index}`, `견적 ${index}`),
      });
    }
  });
  return { mailbox, folder };
}

function allMessages(store, mailboxId) {
  const collected = [];
  let offset = 0;
  const pageSize = 1000;
  let page;
  do {
    page = store.getMessagePage(mailboxId, { limit: pageSize, offset });
    collected.push(...page);
    offset += page.length;
  } while (page.length === pageSize);
  return collected;
}

function assertSurfacesAgree(store, mailboxId) {
  const messages = allMessages(store, mailboxId);
  const links = store.listWorkLinks(mailboxId);
  const classifications = store.getPrecisionClassificationMap(mailboxId);
  const stats = store.workLinkStats(mailboxId);
  const agreement = workLinkProjectionAgreement(messages, links, classifications);
  assert.equal(agreement.ok, true, JSON.stringify(agreement.disagreements.slice(0, 3)));
  assert.equal(stats.linkedCandidate, new Set(links.map((item) => item.graphId)).size);
  assert.equal(stats.unassigned, stats.active - stats.linkedCandidate);
}

test('refresh pages past 1000 then swaps atomically so the 1001st candidate survives', async (t) => {
  const store = await withStore(t);
  const { mailbox } = seedMany(store, 1001);
  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshot: snapshot() }),
  });
  const first = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(first.completeness, 'complete');
  assert.equal(first.messages, 1001);
  assert.equal(first.pages, 2);
  assert.equal(first.stats.linkedCandidate, 1001);
  assert.ok(store.listWorkLinks(mailbox.id).some((item) => item.graphId === 'syn-mail-bulk-1000'));
  assertSurfacesAgree(store, mailbox.id);

  const second = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(second.completeness, 'complete');
  assert.equal(second.stats.linkedCandidate, 1001);
  assert.equal(store.listWorkLinks(mailbox.id).find((item) => item.graphId === 'syn-mail-bulk-1000').status, 'candidate');
  assertSurfacesAgree(store, mailbox.id);
});

test('second-page failure and mid-abort keep last-known-good links and report partial/stale', async (t) => {
  const store = await withStore(t);
  const { mailbox } = seedMany(store, 1001);
  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshot: snapshot() }),
  });
  const first = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(first.stats.linkedCandidate, 1001);

  const aborted = await service.refresh('me', {
    snapshot: snapshot(),
    pageSize: 1000,
    onPage: ({ page }) => {
      if (page === 2) {
        throw Object.assign(new Error('simulated second-page failure'), { code: 'SNAPSHOT_PAGE_FAILED' });
      }
    },
  });
  assert.equal(aborted.completeness, 'partial');
  assert.equal(aborted.stale, true);
  assert.equal(aborted.created, 0);
  assert.equal(aborted.error.code, 'SNAPSHOT_PAGE_FAILED');
  assert.equal(store.workLinkStats(mailbox.id).linkedCandidate, 1001);
  assert.equal(store.getWorkLinkRefreshState(mailbox.id).watermarks.analysisComplete.count, 1001);
  assert.equal(store.listWorkLinks(mailbox.id).find((item) => item.graphId === 'syn-mail-bulk-1000').status, 'candidate');

  const resumed = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(resumed.completeness, 'complete');
  assert.equal(resumed.stale, false);
  assert.equal(resumed.stats.linkedCandidate, 1001);
  assertSurfacesAgree(store, mailbox.id);
});

test('refresh rematches updated mail, drops deleted mail, and keeps moved mail', async (t) => {
  const store = await withStore(t);
  const { mailbox, folder } = seedMany(store, 1, { subject: 'no match yet' });
  const other = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'archive',
    wellKnownName: 'archive',
    displayName: 'Archive',
  });
  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshot: snapshot() }),
  });

  const unmatched = await service.refresh('me', { snapshot: snapshot() });
  assert.equal(unmatched.stats.linkedCandidate, 0);

  const current = store.getMessage(mailbox.id, 'syn-mail-bulk-0');
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage('syn-mail-bulk-0', '[선진 HCI] 수정 견적서 요청', '업데이트된 본문', {
      changeKey: 'change-syn-mail-bulk-0-updated',
    }),
  });
  const updated = await service.refresh('me', { snapshot: snapshot() });
  assert.equal(updated.stats.linkedCandidate, 1);
  assert.equal(store.getPrecisionClassification(mailbox.id, 'syn-mail-bulk-0').projectCandidate.externalId, 'syn-project-sunjin-hci');

  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: other.id,
    message: graphMessage('syn-mail-bulk-0', '[선진 HCI] 수정 견적서 요청', '업데이트된 본문', {
      changeKey: 'change-syn-mail-bulk-0-moved',
      parentFolderId: 'archive',
    }),
  });
  const moved = await service.refresh('me', { snapshot: snapshot() });
  assert.equal(moved.stats.linkedCandidate, 1);
  assert.equal(store.getMessage(mailbox.id, 'syn-mail-bulk-0').parentFolderId, 'archive');

  store.markMessageRemoved({
    mailboxId: mailbox.id,
    folderId: other.id,
    item: { graphId: 'syn-mail-bulk-0', reason: 'deleted' },
  });
  const deleted = await service.refresh('me', { snapshot: snapshot() });
  assert.equal(deleted.stats.linkedCandidate, 0);
  assert.equal(deleted.stats.active, 0);
  const leftover = store.listWorkLinks(mailbox.id, { includeSuperseded: true });
  assert.ok(leftover.every((item) => item.status === 'superseded'));
  const classification = store.getPrecisionClassification(mailbox.id, 'syn-mail-bulk-0');
  assert.equal(classification.projectResolution, 'unassigned');
  assert.ok(current);
});

function injectBeginFailure(store, { times = 1 } = {}) {
  const original = store.db.exec.bind(store.db);
  let remaining = times;
  store.db.exec = (sql) => {
    if (remaining > 0 && /^BEGIN\b/i.test(String(sql))) {
      remaining -= 1;
      throw Object.assign(new Error('injected BEGIN IMMEDIATE failure'), { code: 'TX_BEGIN_FAILED' });
    }
    return original(sql);
  };
  return () => {
    store.db.exec = original;
  };
}

async function sourceChangeFixture(t) {
  const store = await withStore(t);
  const { mailbox, folder } = seedMany(store, 3);
  const service = new WorkLinkService({ store, workSystem: createNotionWorkSystem({ snapshot: snapshot() }) });
  const first = await service.refresh('me', { pageSize: 1 });
  assert.equal(first.status, 'complete');
  const links = store.listWorkLinks(mailbox.id, { includeSuperseded: true });
  const classifications = store.getPrecisionClassificationMap(mailbox.id);
  const next = snapshot();
  next.projects[0].sourceId = 'syn-project-replacement';
  return { store, mailbox, folder, service, first, links, classifications, next };
}

function assertSourceChangeRejected(context, result) {
  const { store, mailbox, first, links, classifications } = context;
  assert.equal(result.status, 'partial');
  assert.equal(result.completeness, 'partial');
  assert.equal(result.stale, true);
  assert.equal(result.created, 0);
  assert.equal(result.error.code, 'WORKLINK_SOURCE_CHANGED');
  assert.equal(result.agreement.ok, null);
  assert.equal(result.agreement.checked, false);
  assert.equal(result.revision, first.revision);
  assert.deepEqual(store.listWorkLinks(mailbox.id, { includeSuperseded: true }), links);
  assert.deepEqual(store.getPrecisionClassificationMap(mailbox.id), classifications);
  const stored = store.getWorkLinkRefreshState(mailbox.id);
  assert.equal(stored.stale, true);
  assert.equal(stored.error.code, 'WORKLINK_SOURCE_CHANGED');
  assert.deepEqual(stored.watermarks.analysisComplete, first.watermarks.analysisComplete);
  assert.equal(store.txDepth, 0);
}

const sourceMutations = [
  ['deletion', ({ store, mailbox, folder }) => store.markMessageRemoved({
    mailboxId: mailbox.id, folderId: folder.id, item: { graphId: 'syn-mail-bulk-0', reason: 'deleted' },
  })],
  ['insertion', ({ store }) => seedMany(store, 1, { start: 3 })],
  ['equal-count ID replacement', ({ store, mailbox, folder }) => {
    store.markMessageRemoved({
      mailboxId: mailbox.id, folderId: folder.id, item: { graphId: 'syn-mail-bulk-0', reason: 'deleted' },
    });
    seedMany(store, 1, { start: 3 });
  }],
  ['body update without changeKey bump', ({ store, mailbox }) => {
    store.db.prepare('UPDATE messages SET body_text = ? WHERE mailbox_id = ? AND graph_id = ?')
      .run('changed synthetic body', mailbox.id, 'syn-mail-bulk-0');
  }],
  ['sender update without changeKey bump', ({ store, mailbox }) => {
    store.db.prepare('UPDATE messages SET sender_email = ? WHERE mailbox_id = ? AND graph_id = ?')
      .run('changed@example.com', mailbox.id, 'syn-mail-bulk-0');
  }],
  ['folder move without changeKey bump', ({ store, mailbox }) => {
    store.db.prepare('UPDATE messages SET parent_folder_graph_id = ? WHERE mailbox_id = ? AND graph_id = ?')
      .run('syn-archive', mailbox.id, 'syn-mail-bulk-0');
  }],
];

for (const [name, mutate] of sourceMutations) {
  test(`V04 rejects ${name} during paging and preserves the last good generation`, async (t) => {
    const context = await sourceChangeFixture(t);
    const { store, mailbox, service, next } = context;
    const result = await service.refresh('me', {
      snapshot: next, pageSize: 1,
      onPage: ({ page }) => { if (page === 1) mutate(context); },
    });
    assertSourceChangeRejected(context, result);
    const retried = await service.refresh('me', { snapshot: next, pageSize: 1 });
    assert.equal(retried.status, 'complete');
    assert.equal(retried.stale, false);
    assert.equal(retried.messages, store.countMessages(mailbox.id));
    assert.ok(retried.links.every(link => link.externalId === 'syn-project-replacement'));
    assertSurfacesAgree(store, mailbox.id);
  });
}

test('V04 rejects mixed collected contents even when the final source returns to its original state', async (t) => {
  const context = await sourceChangeFixture(t);
  const { store, mailbox, service, next } = context;
  const original = store.getMessage(mailbox.id, 'syn-mail-bulk-1').body;
  const update = store.db.prepare('UPDATE messages SET body_text = ? WHERE mailbox_id = ? AND graph_id = ?');
  const result = await service.refresh('me', {
    snapshot: next, pageSize: 1,
    onPage: ({ page }) => {
      if (page === 1) update.run('transient synthetic body', mailbox.id, 'syn-mail-bulk-1');
      if (page === 2) update.run(original, mailbox.id, 'syn-mail-bulk-1');
    },
  });
  assert.equal(store.getMessage(mailbox.id, 'syn-mail-bulk-1').body, original);
  assertSourceChangeRejected(context, result);
});

test('V04 validates source inside the swap transaction, not only after paging', async (t) => {
  const context = await sourceChangeFixture(t);
  const { store, mailbox, service, next } = context;
  const commit = store.commitWorkLinkRefresh.bind(store);
  store.commitWorkLinkRefresh = (...args) => {
    store.db.prepare('UPDATE messages SET subject = ? WHERE mailbox_id = ? AND graph_id = ?')
      .run('changed immediately before BEGIN', mailbox.id, 'syn-mail-bulk-0');
    return commit(...args);
  };
  const result = await service.refresh('me', { snapshot: next, pageSize: 1 });
  store.commitWorkLinkRefresh = commit;
  assertSourceChangeRejected(context, result);
});

test('V04 source guard does not reject changes confined to another mailbox', async (t) => {
  const context = await sourceChangeFixture(t);
  const { store, service, next } = context;
  const other = store.ensureMailbox({ key: 'syn-other', address: 'other@example.com' });
  const folder = store.ensureFolder({ mailboxId: other.id, graphId: 'inbox', displayName: 'Inbox' });
  const result = await service.refresh('me', {
    snapshot: next, pageSize: 1,
    onPage: ({ page }) => {
      if (page === 1) store.upsertNormalizedMessage({
        mailboxId: other.id, folderId: folder.id,
        message: graphMessage('syn-other-message', 'other mailbox', 'synthetic'),
      });
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.stale, false);
  assert.equal(result.created, 3);
});

test('V04 rejects a source change committed by a separate SQLite connection during paging', async (t) => {
  const context = await sourceChangeFixture(t);
  const { store, mailbox, service, next } = context;
  const writer = new SQLiteMailStore({ databasePath: store.databasePath, migrationsDir: resolve('migrations') });
  try {
    const result = await service.refresh('me', {
      snapshot: next, pageSize: 1,
      onPage: ({ page }) => {
        if (page === 1) writer.db.prepare('UPDATE messages SET body_text = ? WHERE mailbox_id = ? AND graph_id = ?')
          .run('separate connection body update', mailbox.id, 'syn-mail-bulk-0');
      },
    });
    assertSourceChangeRejected(context, result);
  } finally {
    writer.close();
  }
});

test('V04 BEGIN IMMEDIATE excludes a second SQLite writer between source validation and swap', async (t) => {
  const context = await sourceChangeFixture(t);
  const { store, mailbox, service, next } = context;
  const writer = new SQLiteMailStore({ databasePath: store.databasePath, migrationsDir: resolve('migrations') });
  writer.db.exec('PRAGMA busy_timeout = 0;');
  const supersede = store.supersedeWorkLinks.bind(store);
  let blocked = false;
  store.supersedeWorkLinks = (...args) => {
    assert.throws(() => writer.db.prepare('UPDATE messages SET body_text = ? WHERE mailbox_id = ?')
      .run('must not enter this generation', mailbox.id), /locked/);
    blocked = true;
    return supersede(...args);
  };
  try {
    const result = await service.refresh('me', { snapshot: next, pageSize: 1 });
    assert.equal(blocked, true);
    assert.equal(result.status, 'complete');
    assert.equal(result.created, 3);
  } finally {
    store.supersedeWorkLinks = supersede;
    writer.close();
  }
});

test('transaction begin failure keeps last-known-good and next refresh restores the full candidate set', async (t) => {
  const store = await withStore(t);
  const { mailbox } = seedMany(store, 1001);
  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshot: snapshot() }),
  });
  const first = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(first.completeness, 'complete');
  assert.equal(first.stats.linkedCandidate, 1001);

  await chmod(store.databasePath, 0o644);
  const restoreExec = injectBeginFailure(store);
  const failed = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  restoreExec();

  assert.equal(failed.completeness, 'partial');
  assert.equal(failed.stale, true);
  assert.equal(failed.status, 'partial');
  assert.equal(failed.created, 0);
  assert.equal(failed.error.code, 'TX_BEGIN_FAILED');
  assert.equal(store.workLinkStats(mailbox.id).linkedCandidate, 1001);
  assert.equal(store.listWorkLinks(mailbox.id).length, 1001);
  assert.equal(store.getWorkLinkRefreshState(mailbox.id).watermarks.analysisComplete.count, 1001);
  assert.equal(store.getWorkLinkRefreshState(mailbox.id).stale, true);
  assert.equal(store.txDepth, 0);
  assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600);
  assertSurfacesAgree(store, mailbox.id);

  const resumed = await service.refresh('me', { snapshot: snapshot(), pageSize: 1000 });
  assert.equal(resumed.completeness, 'complete');
  assert.equal(resumed.stale, false);
  assert.equal(resumed.stats.linkedCandidate, 1001);
  assert.equal(store.listWorkLinks(mailbox.id).find((item) => item.graphId === 'syn-mail-bulk-1000').status, 'candidate');
  assert.equal(store.txDepth, 0);
  assert.equal((await stat(store.databasePath)).mode & 0o777, 0o600);
  assertSurfacesAgree(store, mailbox.id);
});
