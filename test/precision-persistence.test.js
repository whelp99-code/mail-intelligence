import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

function graphMessage({
  id,
  subject,
  body,
  receivedDateTime = '2026-08-30T00:00:00.000Z',
  from = 'customer@example.com',
  name = '고객 담당자',
} = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.com>`,
    subject,
    from: { emailAddress: { address: from, name } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: '박재민' } }],
    receivedDateTime,
    sentDateTime: receivedDateTime,
    createdDateTime: receivedDateTime,
    lastModifiedDateTime: receivedDateTime,
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    webLink: `https://outlook.office.com/mail/${id}`,
    parentFolderId: 'inbox',
  });
}

function openStore(databasePath) {
  return new SQLiteMailStore({
    databasePath,
    migrationsDir: resolve('migrations'),
    now: () => '2026-08-30T01:00:00.000Z',
  });
}

function seed(store) {
  const mailbox = store.ensureMailbox({ key: 'jm@example.com', address: 'jm@example.com' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage({
      id: 'action-1',
      subject: '[선진 HCI] 수정 견적서 요청',
      body: '오늘 오후 3시까지 수정 견적서를 보내주세요.',
    }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage({
      id: 'waiting-1',
      subject: '방화벽 정책표',
      body: '방화벽 정책표는 고객 보안팀 승인 대기 상태입니다.',
    }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: folder.id,
    message: graphMessage({
      id: 'reference-1',
      subject: '월간 뉴스레터',
      body: '이번 달 주요 소식입니다. 별도 회신은 필요 없습니다.',
    }),
  });
  return { mailbox, folder };
}

test('v1.2.0 SQLite data migrates to schema v4 without losing messages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-migration-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { mailbox } = seed(store);
  const status = store.storageStatus();
  assert.equal(status.schemaVersion, 4);
  assert.equal(status.ready, true);
  assert.equal(store.countMessages(mailbox.id), 3);
  assert.equal(status.counts.precision_classifications, 0);
});

test('precision classification persists, is idempotent, and appends history only on change', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-persist-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  seed(store);
  const service = new PrecisionIntelligenceService({
    store,
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  });

  const first = service.classifyStored('jm@example.com');
  assert.equal(first.processed, 3);
  assert.equal(first.changed, 3);
  assert.equal(store.counts().precision_classification_events, 3);

  const second = service.classifyStored('jm@example.com', { force: true });
  assert.equal(second.processed, 3);
  assert.equal(second.changed, 0);
  assert.equal(store.counts().precision_classification_events, 3);

  const action = service.getClassification('jm@example.com', 'action-1').classification;
  assert.equal(action.workState, 'action_required');
  assert.equal(action.nextActor, 'me');
  assert.equal(action.projectResolution, 'candidate');
});

test('explicit project registration is duplicate-safe and reclassifies exact aliases', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-project-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  seed(store);
  const service = new PrecisionIntelligenceService({ store });
  service.classifyStored('jm@example.com');

  const created = service.createProject('jm@example.com', {
    name: '선진엔지니어링 HCI 구축',
    projectKey: 'sunjin-hci',
    aliases: ['선진 HCI'],
  });
  assert.equal(created.project.projectKey, 'sunjin-hci');
  const linked = service.getClassification('jm@example.com', 'action-1').classification;
  assert.equal(linked.projectResolution, 'confirmed');
  assert.equal(linked.primaryProjectId, created.project.id);
  assert.equal(linked.projectName, '선진엔지니어링 HCI 구축');

  assert.throws(() => service.createProject('jm@example.com', {
    name: '중복 프로젝트',
    aliases: ['선진 HCI'],
  }), /already belongs/i);
  assert.equal(service.listProjects('jm@example.com').length, 1);
});

test('user precision correction survives automated reclassification and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-correction-'));
  const databasePath = join(directory, 'mail.sqlite');
  try {
    let store = openStore(databasePath);
    seed(store);
    let service = new PrecisionIntelligenceService({ store });
    service.classifyStored('jm@example.com');
    const corrected = service.correct('jm@example.com', 'action-1', {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
      clearProject: true,
      reasonCode: 'not-work',
      note: '이 메일은 업무가 아닌 참고용으로 확인함',
    });
    assert.equal(corrected.classification.workState, 'reference');
    assert.equal(corrected.classification.reviewStatus, 'corrected');

    const forced = service.classifyStored('jm@example.com', { force: true });
    assert.equal(forced.processed, 3);
    assert.equal(service.getClassification('jm@example.com', 'action-1').classification.workState, 'reference');
    store.close();

    store = openStore(databasePath);
    service = new PrecisionIntelligenceService({ store });
    const afterRestart = service.getClassification('jm@example.com', 'action-1');
    assert.equal(afterRestart.classification.workState, 'reference');
    assert.equal(afterRestart.correction.reasonCode, 'not-work');
    assert.ok(afterRestart.events.length >= 2);
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('intelligent search combines structured filters, FTS evidence, explanation, and deleted exclusion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-search-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { mailbox, folder } = seed(store);
  const service = new PrecisionIntelligenceService({
    store,
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  });
  service.classifyStored('jm@example.com');

  const actionSearch = service.search('jm@example.com', '오늘 내가 처리할 견적', { now: new Date('2026-08-30T01:00:00.000Z') });
  assert.equal(actionSearch.results.length, 1);
  assert.equal(actionSearch.results[0].message.id, 'action-1');
  assert.ok(actionSearch.results[0].matchedBecause.length >= 3);

  const waitingSearch = service.search('jm@example.com', '고객 회신 대기');
  assert.equal(waitingSearch.results.length, 1);
  assert.equal(waitingSearch.results[0].message.id, 'waiting-1');

  store.markMessageRemoved({
    mailboxId: mailbox.id,
    folderId: folder.id,
    item: normalizeGraphMessage({ id: 'waiting-1', '@removed': { reason: 'deleted' } }),
  });
  assert.equal(service.search('jm@example.com', '고객 회신 대기').results.length, 0);
});
