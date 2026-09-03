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
  for (const item of [
    graphMessage({
      id: 'promo-1',
      subject: '견적 계약 웨비나 이벤트',
      body: '이번 주 웨비나 등록 안내입니다. 할인 혜택을 확인하세요. unsubscribe 수신거부',
      from: 'noreply@marketing.example.com',
    }),
    graphMessage({
      id: 'invoice-1',
      subject: '보안 서비스 세금계산서 발행 안내',
      body: '세금계산서가 발행되었습니다. 별도 회신은 필요 없습니다.',
      from: 'billing@example.com',
    }),
    graphMessage({
      id: 'forwarded-1',
      subject: 'Fwd: 오늘까지 제출 요청',
      body: '아래 내용 참고 바랍니다.\n\n---------- Forwarded message ----------\nFrom: old@example.com\nDate: 2026-08-01\nSubject: 제출 요청\n오늘까지 제출 바랍니다.',
    }),
  ]) {
    store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: folder.id, message: item });
  }
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

  const commercialSearch = service.search('jm@example.com', '견적 또는 계약');
  assert.equal(commercialSearch.results.some((item) => item.message.id === 'promo-1'), false);
  const securitySearch = service.search('jm@example.com', '보안 관련');
  assert.equal(securitySearch.results.some((item) => item.message.id === 'invoice-1'), false);
  const dueSearch = service.search('jm@example.com', '이번 주 마감');
  assert.equal(dueSearch.results.some((item) => ['promo-1', 'forwarded-1'].includes(item.message.id)), false);
  const forwarded = service.getClassification('jm@example.com', 'forwarded-1').classification;
  assert.equal(forwarded.workState, 'reference');
  assert.equal(forwarded.dueAt, null);

  store.markMessageRemoved({
    mailboxId: mailbox.id,
    folderId: folder.id,
    item: normalizeGraphMessage({ id: 'waiting-1', '@removed': { reason: 'deleted' } }),
  });
  assert.equal(service.search('jm@example.com', '고객 회신 대기').results.length, 0);
});

test('sent folder learns mailbox sender alias and applies it to custom folders', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-alias-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'me', address: 'me' });
  const sent = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'sent', wellKnownName: 'sentitems', displayName: '보낸 편지함' });
  const custom = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'custom', wellKnownName: '', displayName: '발주 to 파트너' });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: sent.id,
    message: graphMessage({ id: 'sent-seed', subject: '보낸 메일', body: '자료 전달드립니다.', from: 'owner@example.com' }),
  });
  store.upsertNormalizedMessage({
    mailboxId: mailbox.id,
    folderId: custom.id,
    message: graphMessage({ id: 'custom-outgoing', subject: '발주 요청', body: '라이선스 발주 부탁드립니다.', from: 'owner@example.com' }),
  });
  assert.deepEqual(store.getMailboxSenderAliases(mailbox.id), ['owner@example.com']);
  const service = new PrecisionIntelligenceService({ store, now: () => new Date('2026-08-30T01:00:00.000Z') });
  const result = service.classifyOne('me', 'custom-outgoing').classification;
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('incident and security search returns strong current-context matches without insurance or generic VPN contracts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-incident-search-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'jm@example.com', address: 'jm@example.com' });
  const inbox = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox', displayName: '받은 편지함' });
  for (const item of [
    graphMessage({
      id: 'incident-strong',
      subject: '[장애] VPN 서버 접속 오류',
      body: 'VPN 서버 접속 오류 원인을 확인해 주세요.',
      from: 'support@example.com',
    }),
    graphMessage({
      id: 'security-strong',
      subject: '3rd Party Security Consulting / Incident handling 협의',
      body: '보안 관제 범위와 incident handling 지원 방안을 검토해 주세요.',
      from: 'security@example.com',
    }),
    graphMessage({
      id: 'insurance-noise',
      subject: '[KB손해보험] 청약서 송부',
      body: '보안메일 안내와 VPN 관련 보험 약관입니다. 참고 바랍니다.',
      from: 'insurance@example.com',
    }),
    graphMessage({
      id: 'vpn-contract-noise',
      subject: 'VPN 임대 계약 완료',
      body: '계약이 완료되었습니다. 구매시스템에 접속 후 검수 프로세스를 진행해 주시기 바랍니다.',
      from: 'contract@example.com',
    }),
  ]) store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: inbox.id, message: item });
  const service = new PrecisionIntelligenceService({ store, now: () => new Date('2026-08-30T01:00:00.000Z') });
  service.classifyStored('jm@example.com', { force: true });

  const incidentIds = service.search('jm@example.com', '장애', { limit: 5 }).results.map((item) => item.message.id);
  assert.deepEqual(incidentIds, ['incident-strong', 'security-strong']);
  const securityIds = service.search('jm@example.com', '보안', { limit: 5 }).results.map((item) => item.message.id);
  assert.deepEqual(securityIds, ['security-strong', 'incident-strong']);
  assert.equal(securityIds.includes('insurance-noise'), false);
  assert.equal(securityIds.includes('vpn-contract-noise'), false);
});


test('qa-fix7 semantic search finds completed patch tickets and HCI license incidents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-precision-semantic-search-'));
  const databasePath = join(directory, 'mail.sqlite');
  const store = openStore(databasePath);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mailbox = store.ensureMailbox({ key: 'jm@example.com', address: 'jm@example.com' });
  const inbox = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox', displayName: '받은 편지함' });
  for (const item of [
    graphMessage({
      id: 'patch-ticket-completed',
      subject: 'RE: Request to kernel patch file [Ticket#20260001]',
      body: 'The issue has been resolved, so we will proceed to close this ticket.',
      from: 'support@example.com',
    }),
    graphMessage({
      id: 'hci-license-incident',
      subject: '[ITAC] License issue [Ticket#20260002]',
      body: 'The HCI license failed and the virtual machines cannot start. Please check this issue.',
      from: 'support@example.com',
    }),
    graphMessage({
      id: 'hci-license-quotation',
      subject: 'HCI 라이선스 견적',
      body: '내년도 HCI 라이선스 견적서를 전달드립니다.',
      from: 'sales@example.com',
    }),
  ]) store.upsertNormalizedMessage({ mailboxId: mailbox.id, folderId: inbox.id, message: item });

  const service = new PrecisionIntelligenceService({ store, now: () => new Date('2026-08-30T01:00:00.000Z') });
  service.classifyStored('jm@example.com', { force: true });

  const completed = service.search('jm@example.com', '완료된 패치 티켓', { limit: 5 });
  assert.deepEqual(completed.results.map((item) => item.message.id), ['patch-ticket-completed']);

  const incident = service.search('jm@example.com', 'HCI 라이선스 장애', { limit: 5 });
  assert.deepEqual(incident.results.map((item) => item.message.id), ['hci-license-incident']);
});
