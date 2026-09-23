import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createNotionWorkSystem, createRecordingFetch, loadNotionSnapshot, mastersFromSnapshot, validateSnapshotIdentity } from '../src/adapters/notion-work-system.js';
import { matchMessageToMasters, WorkLinkService } from '../src/application/work-links.js';
import { workLinkProjectionAgreement } from '../src/domain/work-link-projection.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

const FIXTURE = resolve('test/fixtures/notion-jm-business-os.snapshot.json');

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
  const directory = await mkdtemp(join(tmpdir(), 'mail-intelligence-worklinks-'));
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

function seedInbox(store, messages) {
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  store.transaction(() => {
    for (const message of messages) {
      store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message });
    }
  });
  return { mailbox, folder };
}

function snapshotWithProject(externalId, name = '선진엔지니어링 HCI 구축', aliases = ['선진 HCI']) {
  return {
    workspaceId: 'syn-workspace-jm-business-os',
    snapshotId: `syn-snapshot-${externalId}`,
    snapshotHash: 'sha256:synthetic-not-production',
    capturedAt: '2026-09-11T00:00:00Z',
    readOnlySource: true,
    accounts: [],
    projects: [{
      sourceId: externalId,
      sourceUrl: `https://example.invalid/notion/${externalId}`,
      properties: {
        '프로젝트명(Title)': name,
        프로젝트ID: 'PRJ-2026-001',
        상태: '진행',
        '별칭': aliases,
      },
    }],
    activities: [],
    finance: [],
  };
}

function emptySnapshot() {
  return {
    workspaceId: 'syn-workspace-empty',
    snapshotId: 'syn-snapshot-empty',
    snapshotHash: 'sha256:synthetic-empty',
    capturedAt: '2026-09-11T00:00:00Z',
    readOnlySource: true,
    accounts: [],
    projects: [],
    activities: [],
    finance: [],
  };
}

function assertSurfacesAgree(store, mailboxId, result) {
  const messages = store.getMessagePage(mailboxId, { limit: 1000, offset: 0 });
  const links = store.listWorkLinks(mailboxId);
  const classifications = store.getPrecisionClassificationMap(mailboxId);
  const stats = store.workLinkStats(mailboxId);
  const agreement = workLinkProjectionAgreement(messages, links, classifications);
  assert.equal(agreement.ok, true, JSON.stringify(agreement.disagreements));
  assert.equal(stats.linkedCandidate, new Set(links.map((item) => item.graphId)).size);
  assert.equal(stats.unassigned, stats.active - stats.linkedCandidate);
  if (result) {
    assert.equal(result.stats.linkedCandidate, stats.linkedCandidate);
    assert.equal(result.stats.unassigned, stats.unassigned);
    assert.equal(result.agreement.ok, true);
  }
}

test('fixture adapter rejects snapshot missing workspace, hash, or captured_at', () => {
  assert.equal(validateSnapshotIdentity(loadNotionSnapshot(FIXTURE)).ok, true);
  assert.equal(validateSnapshotIdentity({
    snapshotHash: 'sha256:synthetic-not-production',
    capturedAt: '2026-09-11T00:00:00Z',
  }).code, 'SNAPSHOT_WORKSPACE_MISSING');
  assert.equal(validateSnapshotIdentity({
    workspaceId: 'syn-workspace-jm-business-os',
    capturedAt: '2026-09-11T00:00:00Z',
  }).code, 'SNAPSHOT_HASH_MISSING');
  assert.equal(validateSnapshotIdentity({
    workspaceId: 'syn-workspace-jm-business-os',
    snapshotHash: 'sha256:synthetic-not-production',
  }).code, 'SNAPSHOT_CAPTURED_AT_MISSING');
  assert.throws(
    () => loadNotionSnapshot({ projects: [], accounts: [] }),
    { code: 'SNAPSHOT_WORKSPACE_MISSING' },
  );
});

test('fixture snapshot maps three synthetic mails without live Notion ids', () => {
  const snapshot = loadNotionSnapshot(FIXTURE);
  assert.equal(snapshot.readOnlySource, true);
  assert.match(JSON.stringify(snapshot), /syn-/);
  assert.doesNotMatch(JSON.stringify(snapshot), /[0-9a-f]{32}/i);
  const masters = mastersFromSnapshot(snapshot);
  assert.equal(masters.filter((item) => item.objectType === 'engagement').length, 1);
  assert.equal(masters.filter((item) => item.objectType === 'account').length, 2);

  const quote = matchMessageToMasters(graphMessage('syn-mail-quote', '[선진 HCI] 수정 견적서 요청', '오늘 오후 수정 견적서를 보내주세요.'), masters);
  assert.equal(quote.length, 1);
  assert.equal(quote[0].status, 'candidate');
  assert.equal(quote[0].objectType, 'engagement');
  assert.equal(quote[0].externalId, 'syn-project-sunjin-hci');

  const thanks = matchMessageToMasters(graphMessage('syn-mail-thanks', '소개 미팅 감사합니다', '다음 일정은 조율하겠습니다.', {
    from: { emailAddress: { address: 'hong@example.com', name: '홍길동' } },
  }), masters);
  assert.equal(thanks.length, 1);
  assert.equal(thanks[0].objectType, 'account');
  assert.equal(thanks[0].externalId, 'syn-account-sunjin');
  assert.equal(thanks[0].status, 'candidate');

  const news = matchMessageToMasters(graphMessage('syn-mail-newsletter', '주간 뉴스레터', '구독 감사합니다.', {
    from: { emailAddress: { address: 'noreply@news.example', name: 'News' } },
  }), masters);
  assert.deepEqual(news, []);
});

test('Notion adapter lists fixture masters and throws on write without HTTP', async () => {
  const calls = [];
  const fetchImpl = createRecordingFetch(calls);
  const port = createNotionWorkSystem({ snapshotPath: FIXTURE });
  const masters = await port.listMasters();
  assert.ok(masters.length >= 2);
  await assert.rejects(() => port.proposeActivity({ summary: 'should not write' }), { code: 'NOTION_WRITE_DISABLED' });
  await assert.rejects(() => fetchImpl('https://api.notion.com/v1/pages', { method: 'POST' }), { code: 'NOTION_HTTP_FORBIDDEN' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
});

test('WorkLink refresh persists candidates only and reports rates', async (t) => {
  const store = await withStore(t);
  assert.equal(store.storageStatus().schemaVersion, 8);
  const mailbox = store.ensureMailbox({ key: 'me', address: '' });
  const folder = store.ensureFolder({
    mailboxId: mailbox.id,
    graphId: 'inbox',
    wellKnownName: 'inbox',
    displayName: 'Inbox',
  });
  for (const message of [
    graphMessage('syn-mail-quote', '[선진 HCI] 수정 견적서 요청', '오늘 오후 수정 견적서를 보내주세요.'),
    graphMessage('syn-mail-thanks', '소개 미팅 감사합니다', '다음 일정은 조율하겠습니다.', {
      from: { emailAddress: { address: 'hong@example.com', name: '홍길동' } },
    }),
    graphMessage('syn-mail-newsletter', '주간 뉴스레터', '구독 감사합니다.', {
      from: { emailAddress: { address: 'noreply@news.example', name: 'News' } },
    }),
  ]) {
    store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message });
  }

  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshotPath: FIXTURE }),
  });
  const result = await service.refresh('me');
  assert.equal(result.created, 2);
  assert.equal(result.stats.active, 3);
  assert.equal(result.stats.linkedCandidate, 2);
  assert.equal(result.stats.unassigned, 1);
  assert.ok(result.links.every((item) => item.status === 'candidate'));
  assert.equal(result.links.some((item) => item.status === 'confirmed'), false);

  assert.throws(
    () => store.saveWorkLink(mailbox.id, {
      messageDatabaseId: store.getMessageRecord(mailbox.id, 'syn-mail-quote').id,
      graphId: 'syn-mail-quote',
      objectType: 'engagement',
      system: 'notion',
      externalId: 'syn-project-sunjin-hci',
      name: 'should fail',
      confidence: 1,
      status: 'confirmed',
    }),
    { code: 'WORK_LINK_AUTO_CONFIRM_FORBIDDEN' },
  );
  assert.equal(result.completeness, 'complete');
  assert.equal(result.stale, false);
  assertSurfacesAgree(store, mailbox.id, result);
});

test('WorkLink projection replaces A with B and clears A when unlinked', async (t) => {
  const store = await withStore(t);
  const { mailbox } = seedInbox(store, [
    graphMessage('syn-mail-quote', '[선진 HCI] 수정 견적서 요청', '오늘 오후 수정 견적서를 보내주세요.'),
  ]);
  const service = new WorkLinkService({ store, workSystem: createNotionWorkSystem({ snapshot: snapshotWithProject('syn-project-a') }) });

  const first = await service.refresh('me', { snapshot: snapshotWithProject('syn-project-a') });
  assert.equal(first.completeness, 'complete');
  assert.equal(first.links[0].externalId, 'syn-project-a');
  assert.equal(store.getPrecisionClassification(mailbox.id, 'syn-mail-quote').projectCandidate.externalId, 'syn-project-a');
  assertSurfacesAgree(store, mailbox.id, first);

  const replaced = await service.refresh('me', { snapshot: snapshotWithProject('syn-project-b') });
  assert.equal(replaced.links.filter((item) => item.status === 'candidate').length, 1);
  assert.equal(replaced.links[0].externalId, 'syn-project-b');
  const afterB = store.getPrecisionClassification(mailbox.id, 'syn-mail-quote');
  assert.equal(afterB.projectResolution, 'candidate');
  assert.equal(afterB.projectCandidate.externalId, 'syn-project-b');
  assert.equal(afterB.projectCandidate.source, 'notion-worklink');
  assertSurfacesAgree(store, mailbox.id, replaced);

  const cleared = await service.refresh('me', { snapshot: emptySnapshot() });
  assert.equal(cleared.stats.linkedCandidate, 0);
  assert.equal(cleared.stats.unassigned, 1);
  const afterClear = store.getPrecisionClassification(mailbox.id, 'syn-mail-quote');
  assert.equal(afterClear.projectResolution, 'unassigned');
  assert.equal(afterClear.projectCandidate.externalId || null, null);
  assertSurfacesAgree(store, mailbox.id, cleared);
});

test('identical WorkLink refresh is idempotent and preserves user-confirmed classification', async (t) => {
  const store = await withStore(t);
  const { mailbox } = seedInbox(store, [
    graphMessage('syn-mail-quote', '[선진 HCI] 수정 견적서 요청', '오늘 오후 수정 견적서를 보내주세요.'),
    graphMessage('syn-mail-confirmed', '[선진 HCI] 사용자 확정', '이 메일은 사람이 확정했습니다.'),
  ]);
  store.savePrecisionClassification(mailbox.id, 'syn-mail-confirmed', {
    workState: 'action_required',
    nextActor: 'me',
    priority: 'high',
    projectResolution: 'confirmed',
    projectCandidate: { label: '수동 확정 프로젝트', source: 'user', externalId: 'user-project-keep' },
    signals: [],
    evidence: {},
    confidence: { project: 1 },
    reviewReasons: [],
    source: 'user-corrected',
    provider: 'user',
    reviewStatus: 'confirmed',
  });

  const service = new WorkLinkService({
    store,
    workSystem: createNotionWorkSystem({ snapshot: snapshotWithProject('syn-project-a') }),
  });
  const first = await service.refresh('me', { snapshot: snapshotWithProject('syn-project-a') });
  const second = await service.refresh('me', { snapshot: snapshotWithProject('syn-project-a') });
  assert.equal(first.completeness, 'complete');
  assert.equal(second.completeness, 'complete');
  assert.equal(second.stats.linkedCandidate, first.stats.linkedCandidate);
  assert.equal(
    store.getPrecisionClassification(mailbox.id, 'syn-mail-quote').projectCandidate.externalId,
    'syn-project-a',
  );
  const confirmed = store.getPrecisionClassification(mailbox.id, 'syn-mail-confirmed');
  assert.equal(confirmed.projectResolution, 'confirmed');
  assert.equal(confirmed.projectCandidate.externalId, 'user-project-keep');
  assert.equal(confirmed.source, 'user-corrected');
  const confirmedLink = second.links.find((item) => item.graphId === 'syn-mail-confirmed');
  assert.equal(confirmedLink.externalId, 'syn-project-a');
  assertSurfacesAgree(store, mailbox.id, second);
});
