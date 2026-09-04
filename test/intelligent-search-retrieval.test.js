import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PrecisionIntelligenceService } from '../src/application/precision-intelligence.js';
import { parseIntelligentQuery } from '../src/domain/intelligent-search.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';

async function withStore(t) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'mail-intelligence-search-'));
  const store = new SQLiteMailStore({
    databasePath: join(directory, 'mail.sqlite'),
    migrationsDir: resolve('migrations'),
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

function message(id, subject, body, folderId, bodyPreview = body) {
  return normalizeGraphMessage({
    id,
    changeKey: `change-${id}`,
    conversationId: `conversation-${id}`,
    internetMessageId: `<${id}@example.test>`,
    subject,
    bodyPreview,
    body: { contentType: 'text', content: body },
    from: { emailAddress: { address: 'customer@example.test', name: 'Customer' } },
    toRecipients: [{ emailAddress: { address: 'me@example.test', name: 'Owner' } }],
    receivedDateTime: '2026-09-04T00:00:00.000Z',
    sentDateTime: '2026-09-04T00:00:00.000Z',
    createdDateTime: '2026-09-04T00:00:00.000Z',
    lastModifiedDateTime: '2026-09-04T00:00:00.000Z',
    parentFolderId: folderId,
    isRead: false,
    isDraft: false,
    hasAttachments: false,
  });
}

function classification({ workState = 'action_required', nextActor = 'me', reviewStatus = 'auto', signals = [], dueAt = null } = {}) {
  return {
    workState,
    nextActor,
    priority: 'normal',
    dueAt,
    duePrecision: dueAt ? 'date' : 'none',
    projectResolution: 'unassigned',
    signals,
    evidence: {},
    confidence: {},
    reviewReasons: [],
    reviewStatus,
  };
}

async function seedSearchFixture(t) {
  const store = await withStore(t);
  const mailbox = store.ensureMailbox({ key: 'me@example.test', address: 'me@example.test' });
  const folders = Object.fromEntries(['inbox', 'deleteditems', 'junkemail'].map((wellKnownName) => {
    const folder = store.ensureFolder({
      mailboxId: mailbox.id,
      graphId: wellKnownName,
      wellKnownName,
      displayName: wellKnownName,
    });
    return [wellKnownName, folder];
  }));
  const seed = (id, subject, body, folder, value, bodyPreview) => {
    store.upsertNormalizedMessage({
      mailboxId: mailbox.id,
      folderId: folders[folder].id,
      message: message(id, subject, body, folder, bodyPreview),
    });
    store.savePrecisionClassification(mailbox.id, id, value);
  };
  seed('inbox-action', 'alpha beta request', 'Current alpha beta action', 'inbox', classification());
  seed('wrong-actor', 'gamma update', 'Current gamma update', 'inbox', classification({ nextActor: 'external_party' }));
  seed('deleted-action', 'alpha deleted', 'Deleted alpha action', 'deleteditems', classification());
  seed('junk-action', 'gamma junk', 'Junk gamma action', 'junkemail', classification());
  seed('inbox-review', 'charlie echo review', 'Current charlie echo review', 'inbox', classification({
    workState: 'review_required',
    nextActor: 'unknown',
    reviewStatus: 'review_required',
  }));
  seed('deleted-review', 'foxtrot review', 'Deleted foxtrot review', 'deleteditems', classification({
    workState: 'review_required',
    nextActor: 'unknown',
    reviewStatus: 'review_required',
  }));
  seed('due-action', 'alpha beta deadline', 'Current alpha beta deadline', 'inbox', classification({ dueAt: '2026-09-10T03:00:00.000Z' }));
  seed('wrong-day', 'alpha gamma deadline', 'Wrong day alpha gamma', 'inbox', classification({ dueAt: '2026-09-11T03:00:00.000Z' }));
  seed('security-remote', '보안 Security remote access 원격 접속', '보안 Security remote access 원격 접속 issue', 'inbox', classification({ signals: ['incident_security'] }));
  seed('security-local', 'Security local alert', 'Security local issue', 'inbox', classification({ signals: ['incident_security'] }));
  seed('security-outage-remote', '보안 장애 원격 접속', '보안 장애 원격 접속 조치', 'inbox', classification({ signals: ['incident_security'] }));
  seed('security-generic-remote', '전송 오류 원격 접속', '전송 오류 원격 접속', 'inbox', classification());
  seed('security-unclassified-remote', '보안 원격 접속', '보안 원격 접속', 'inbox', classification());
  seed('security-simple-classified', '보안 점검', '보안 점검', 'inbox', classification({ signals: ['incident_security'] }));
  seed('security-simple-unclassified', '보안 점검', '보안 점검', 'inbox', classification());
  seed('security-body-supplemented', '원격 접속 안내', '보안 장애 원격 접속 추가 조치', 'inbox', classification({ signals: ['incident_security'] }), '원격 접속 안내');
  seed('security-quoted-body-only', '일반 안내', '보안 장애 원격 접속 인용문', 'inbox', classification({ signals: ['incident_security'] }), '일반 안내');
  seed('review-maintenance', '유지보수 계약 검토', 'Current maintenance contract review', 'inbox', classification({
    workState: 'review_required',
    nextActor: 'unknown',
    reviewStatus: 'review_required',
    signals: ['quotation_contract'],
  }));
  seed('review-contract', '계약 검토', 'Current contract review', 'inbox', classification({
    workState: 'review_required',
    nextActor: 'unknown',
    reviewStatus: 'review_required',
    signals: ['quotation_contract'],
  }));
  const service = new PrecisionIntelligenceService({ store });
  service.classifyStored = () => ({ processed: 0, changed: 0, reviewRequired: 0 });
  return service;
}

test('zero-result AND retries residual text with OR while preserving state, actor, and lifecycle filters', async (t) => {
  const service = await seedSearchFixture(t);

  const response = service.search('me@example.test', '내가 해야 할 alpha beta gamma');

  assert.equal(response.fallbackApplied, true);
  assert.equal(response.effectiveResidualOperator, 'COVERAGE');
  assert.ok(response.results.some((result) => result.message.id === 'inbox-action'));
  assert.ok(response.results[0].matchedBecause.includes('메일 근거 검색: alpha beta gamma'));
  assert.deepEqual(response.parsedQuery.filters.workStates, ['action_required']);
  assert.deepEqual(response.parsedQuery.filters.nextActors, ['me']);
});

test('zero-result AND fallback retains review-only filtering and excludes deleted lifecycle mail', async (t) => {
  const service = await seedSearchFixture(t);

  const response = service.search('me@example.test', '검토 필요 charlie echo foxtrot');

  assert.equal(response.fallbackApplied, true);
  assert.equal(response.effectiveResidualOperator, 'COVERAGE');
  assert.deepEqual(response.results.map((result) => result.message.id), ['inbox-review']);
  assert.equal(response.parsedQuery.filters.reviewOnly, true);
});

test('nonzero AND retrieval remains unbroadened', async (t) => {
  const service = await seedSearchFixture(t);

  const response = service.search('me@example.test', '내가 해야 할 alpha beta');

  assert.equal(response.fallbackApplied, false);
  assert.equal(response.effectiveResidualOperator, 'AND');
  assert.ok(response.results.some((result) => result.message.id === 'inbox-action'));
});

test('absolute deadline anchor retains only the KST due day during coverage fallback', async (t) => {
  const service = await seedSearchFixture(t);
  const response = service.search('me@example.test', '2026-09-10까지 alpha beta gamma');
  assert.equal(response.fallbackApplied, true);
  assert.deepEqual(response.results.map((result) => result.message.id), ['due-action']);
  assert.ok(response.results[0].matchedAnchorKinds.includes('due_date'));
});

test('security remote-session anchor requires both security and remote groups', async (t) => {
  const service = await seedSearchFixture(t);
  const response = service.search('me@example.test', 'remote access security');
  assert.deepEqual(response.results.map((result) => result.message.id), ['security-remote']);
  assert.ok(response.results[0].matchedAnchorKinds.includes('security_remote_session'));
});

test('bare security outage wording accepts remote plus either current security or outage group', async (t) => {
  const service = await seedSearchFixture(t);
  const response = service.search('me@example.test', '원격 접속 보안 장애 추가');
  assert.equal(response.fallbackApplied, true);
  assert.ok(response.results.some((result) => result.message.id === 'security-remote'));
  assert.ok(response.results.some((result) => result.message.id === 'security-outage-remote'));
  assert.ok(response.results.some((result) => result.message.id === 'security-unclassified-remote'));
  assert.equal(response.results.some((result) => result.message.id === 'security-generic-remote'), false);
  assert.equal(response.results.some((result) => result.message.id === 'security-quoted-body-only'), false);
});

test('compound remote security search does not require a classification signal, while simple security search does', async (t) => {
  const service = await seedSearchFixture(t);
  const compound = service.search('me@example.test', '원격 접속 보안');
  assert.ok(compound.results.some((result) => result.message.id === 'security-unclassified-remote'));
  assert.equal(compound.parsedQuery.filters.signals.includes('incident_security'), false);

  const simple = service.search('me@example.test', '보안 점검');
  assert.deepEqual(simple.results.map((result) => result.message.id), ['security-simple-classified']);
  assert.deepEqual(simple.parsedQuery.filters.signals, ['incident_security']);
});

test('explicit security and outage conjunction requires all strict groups but permits bounded covered body supplementation', async (t) => {
  const service = await seedSearchFixture(t);
  const parsed = parseIntelligentQuery('원격 접속 보안 및 장애', { now: new Date('2026-09-04T00:00:00.000Z') });
  const strict = service.store.intelligentSearch(service.ensureMailbox('me@example.test').id, parsed);
  assert.deepEqual(strict.map((result) => result.message.id), ['security-outage-remote']);

  const response = service.search('me@example.test', '원격 접속 보안 및 장애 추가');
  assert.equal(response.fallbackApplied, true);
  assert.ok(response.results.some((result) => result.message.id === 'security-body-supplemented'));
  assert.equal(response.results.some((result) => result.message.id === 'security-quoted-body-only'), false);
});

test('review contract search keeps review state hard and ranks maintenance evidence first', async (t) => {
  const service = await seedSearchFixture(t);
  const response = service.search('me@example.test', '검토 필요 계약');
  assert.equal(response.parsedQuery.filters.reviewOnly, true);
  assert.deepEqual(response.results.slice(0, 2).map((result) => result.message.id), ['review-maintenance', 'review-contract']);
  assert.ok(response.results.every((result) => result.classification.reviewStatus === 'review_required'));
});