import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { createProductionIntakeBinding, ingestAfterCommittedSync } from '../src/application/sync-work-intake.js';
import { CwosMailCandidateWriter } from '../src/adapters/cwos-mail-candidate-writer.js';

async function fixture(t, {
  subject = 'Example Project quote request', body = 'Please review Example Project.',
  workspaceId = 'fixture-workspace',
  senderEmail = 'sender@example.invalid',
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mr-candidates-'));
  const store = new SQLiteMailStore({ databasePath: join(directory, 'mail.sqlite') });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const mailbox = store.ensureMailbox({ key: 'me' });
  const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
  store.applyDeltaPage({
    mailboxId: mailbox.id, folderId: folder.id,
    syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }), pageIndex: 0,
    items: [normalizeGraphMessage({
      id: 'mail', changeKey: 'v1', subject,
      from: { emailAddress: { address: senderEmail } },
      receivedDateTime: '2026-10-09T00:00:00Z',
      body: { contentType: 'text', content: body },
    })],
    deltaLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?fixture=1',
  });
  const posts = [];
  const binding = createProductionIntakeBinding({
    db: store.db, mailboxUser: 'me', workspaceId,
    readMasters: async () => ({
      workspaceId, items: [{ objectType: 'engagement', externalId: 'project', name: 'Example Project' }],
      provenance: { runtimeVersion: 4 },
    }),
    candidateWriter: new CwosMailCandidateWriter({
      baseUrl: 'http://127.0.0.1', apiKey: 'fixture-writer-key-0123456789abcdef',
      workspaceId, principalId: 'writer', mailbox: 'delegate@example.invalid',
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        posts.push({ path: url.pathname, method: options.method, body });
        return Response.json({
          candidate: { ...body, id: `mail-candidate-${'b'.repeat(64)}`, status: 'CANDIDATE',
            confirmed: false, freshness: 'producer_unverified', createdByPrincipalId: 'writer', version: 1 },
          runtimeVersion: 5,
        }, { status: 201 });
      },
    }),
  });
  const run = () => ingestAfterCommittedSync({ store, ...binding, mailboxUser: 'me', workspaceId, messageIds: ['mail', 'mail'] });
  return { store, binding, run, posts };
}

test('committed intake automatically appends one source candidate and retains local evidence', async (t) => {
  const { store, run, posts } = await fixture(t);
  const result = await run();
  assert.equal(result.accepted, 1);
  assert.equal(result.deliveredCandidates.length, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/cwos/v2/mail-candidates');
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].body.expectedVersion, 4);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  const evidence = JSON.parse(store.db.prepare('SELECT evidence_json FROM mail_work_links').get().evidence_json);
  assert.ok(evidence.some(item => item.kind === 'mail_source'));
});

test('disabled writer performs local intake only', async (t) => {
  const { binding, run, posts, store } = await fixture(t);
  binding.candidateWriter = null;
  const result = await run();
  assert.equal(result.accepted, 1);
  assert.equal(result.deliveredCandidates.length, 0);
  assert.equal(posts.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
});

test('MS queues received source keys once without requiring CRM candidate delivery', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, { workspaceId });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  binding.candidateWriter = null;
  await run();
  await run();
  const rows = store.db.prepare('SELECT * FROM mail_company_memory_outbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, workspaceId);
  assert.equal(rows[0].kind, 'INBOX_RECEIVED');
  assert.equal(rows[0].source_locator, 'mail');
  assert.equal(rows[0].source_event_id, 'mail');
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[0].version, 1);
  assert.equal(Object.hasOwn(rows[0], 'body'), false);
  assert.equal(posts.length, 0);
});

test('MS scope mismatch stays visible while MR delivery remains independent', async (t) => {
  const { store, binding, run, posts } = await fixture(t);
  binding.companyMemory = { workspaceId: '44444444-4444-4444-8444-444444444444', provider: 'outlook' };
  const result = await run();
  assert.equal(result.failures[0].code, 'COMPANY_WORKSPACE_MISMATCH');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
  assert.equal(posts.length, 1);
});

test('MS rejects outgoing draft deleted and junk sources before queueing', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run } = await fixture(t, { workspaceId });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  store.db.prepare("UPDATE messages SET is_draft=1 WHERE graph_id='mail'").run();
  assert.equal((await run()).skipped[0].code, 'RECEIVED_MAIL_REQUIRED');
  store.db.prepare("UPDATE messages SET is_draft=0 WHERE graph_id='mail'").run();
  for (const folder of ['sentitems', 'drafts', 'deleteditems', 'junkemail']) {
    store.ensureFolder({ mailboxId: store.getMailbox('me').id, graphId: 'inbox', wellKnownName: folder, displayName: folder });
    const result = await run();
    assert.equal(result.accepted, 0);
    assert.equal(result.skipped[0].code, 'RECEIVED_MAIL_REQUIRED');
  }
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
});

test('delivery failure is visible while committed mail and local candidates survive', async (t) => {
  const { binding, run, store } = await fixture(t);
  binding.candidateWriter.fetchImpl = async () => new Response('', { status: 403 });
  const result = await run();
  assert.equal(result.accepted, 1);
  assert.equal(result.deliveredCandidates.length, 0);
  assert.equal(result.failures[0].code, 'CWOS_CANDIDATE_DENIED');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
});

test('non-candidate mail does not append CRM data', async (t) => {
  const { binding, run, posts } = await fixture(t, { subject: 'Newsletter', body: 'Weekly news. No action required.' });
  binding.workSystem.cwosClient.readMasters = async () => ({
    workspaceId: 'fixture-workspace', items: [], provenance: { runtimeVersion: 4 },
  });
  const result = await run();
  assert.equal(result.accepted, 1);
  assert.equal(result.deliveredCandidates.length, 0);
  assert.equal(posts.length, 0);
});

for (const example of [
  {
    name: 'advertisement',
    subject: '[광고] Example Project newsletter',
    body: 'Example Project weekly offers. Unsubscribe to stop receiving this newsletter.',
    rule: 'marketing-reference',
  },
  {
    name: 'automatic notification',
    subject: 'Example Project notification',
    body: 'Example Project notification. This email is automatically generated. Do not reply.',
    senderEmail: 'no-reply@example.invalid',
    rule: 'automated-notification-reference',
  },
]) {
  test(`${example.name} reference retains evidence without CRM or MS publication`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run, posts } = await fixture(t, { ...example, workspaceId });
    binding.companyMemory = { workspaceId, provider: 'outlook' };
    const result = await run();
    assert.equal(result.accepted, 1);
    assert.deepEqual(result.failures, []);
    const classification = store.getPrecisionClassification(store.getMailbox('me').id, 'mail');
    assert.equal(classification.workState, 'reference');
    assert.equal(classification.evidence.workState.rule, example.rule);
    assert.deepEqual(result.candidateSkipped, [{ messageId: 'mail', code: 'NON_BUSINESS_REFERENCE', rule: example.rule }]);
    assert.equal(posts.length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
    const audit = store.db.prepare("SELECT payload_json FROM audit_events WHERE event_type='mail.intake.completed' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(audit.payload_json).candidatesSkipped, 1);
  });
}

test('automated business requests still publish CRM and MS candidates', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, {
    workspaceId, senderEmail: 'no-reply@example.invalid',
    subject: 'Example Project 견적 검토', body: '자동 시스템 알림입니다. Example Project 견적서를 오늘 보내 주세요.',
  });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  const result = await run();
  assert.notEqual(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
  assert.deepEqual(result.candidateSkipped, []);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

for (const example of [
  { name: 'no-reply quote review', senderEmail: 'no-reply@example.invalid', body: '견적서 검토 부탁드립니다.' },
  { name: 'no-reply purchase and delivery reply', senderEmail: 'no-reply@example.invalid', body: '발주 승인 후 납품 일정 회신 부탁드립니다.' },
  { name: 'alert meeting attendance', senderEmail: 'alert@example.invalid', body: '내일 고객 미팅 참석 부탁드립니다.' },
  { name: 'discounted quote review', subject: 'Example Project 할인 견적서', body: '할인 견적서 검토 부탁드립니다.' },
  { name: 'marketing material request', subject: 'Example Project 마케팅 자료', body: '마케팅 자료 보내 주세요.' },
  { name: 'review completion and contract request', subject: 'Example Project 심사 완료 안내', body: '심사 완료 안내입니다. 계약 진행 부탁드립니다.' },
]) {
  test(`${example.name} retains CRM and MS candidates despite a reference rule`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run, posts } = await fixture(t, { ...example, workspaceId });
    binding.companyMemory = { workspaceId, provider: 'outlook' };
    const result = await run();
    assert.deepEqual(result.failures, []);
    assert.equal(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
    assert.deepEqual(result.candidateSkipped, []);
    assert.equal(posts.length, 1);
    assert.equal(result.deliveredCandidates.length, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
  });
}

for (const example of [
  {
    name: 'quoted request',
    body: 'Example Project 자동 알림입니다.\n\n-----Original Message-----\nFrom: sender@example.invalid\n\n견적서 검토 부탁드립니다.',
  },
  { name: 'negated request', body: 'Example Project 견적서 검토할 필요 없습니다. 자동 알림입니다.' },
  { name: 'conditional contact footer', body: 'Example Project 자동 알림입니다. 자료가 필요하시면 연락 부탁드립니다.' },
]) {
  test(`${example.name} does not override automatic-reference exclusion`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run, posts } = await fixture(t, { ...example, workspaceId, senderEmail: 'no-reply@example.invalid' });
    binding.companyMemory = { workspaceId, provider: 'outlook' };
    const result = await run();
    assert.equal(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
    assert.equal(result.candidateSkipped.length, 1);
    assert.equal(posts.length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
  });
}

for (const example of [
  { name: 'no-reply attachment check', senderEmail: 'no-reply@example.invalid', body: '첨부파일을 확인해 주시기 바랍니다' },
  { name: 'no-reply reply boilerplate', senderEmail: 'no-reply@example.invalid', body: '회신 부탁드립니다' },
  { name: 'notification file check', senderEmail: 'notification@example.invalid', body: '파일을 확인 부탁드립니다' },
  { name: 'advertisement mail check', subject: '[광고] Example Project 할인', body: '메일을 확인 부탁드립니다' },
  { name: 'English attached-file boilerplate', senderEmail: 'no-reply@example.invalid', body: 'Please see the attached file' },
]) {
  test(`${example.name} remains excluded without a business target`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run, posts } = await fixture(t, {
      subject: 'Example Project', ...example, workspaceId,
    });
    binding.companyMemory = { workspaceId, provider: 'outlook' };
    const result = await run();
    assert.deepEqual(result.failures, []);
    assert.equal(result.accepted, 1);
    assert.equal(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
    assert.equal(result.candidateSkipped.length, 1);
    assert.equal(result.candidateSkipped[0].code, 'NON_BUSINESS_REFERENCE');
    assert.equal(result.deliveredCandidates.length, 0);
    assert.equal(posts.length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  });
}

test('ordinary reference knowledge still publishes CRM and MS candidates', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, {
    workspaceId, subject: 'Example Project reference material',
    body: 'Example Project information. FYI, no action required.',
  });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  const result = await run();
  assert.equal(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
  assert.deepEqual(result.candidateSkipped, []);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

test('an explicit correction outranks the automatic reference publication gate', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, {
    workspaceId, subject: '[광고] Example Project newsletter',
    body: 'Example Project weekly offers. Unsubscribe to stop receiving this newsletter.',
  });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  await run();
  store.savePrecisionCorrection(store.getMailbox('me').id, 'mail', {
    overrides: { priority: 'normal' }, reasonCode: 'user-classification',
  });
  const result = await run();
  assert.equal(store.getPrecisionClassification(store.getMailbox('me').id, 'mail').workState, 'reference');
  assert.deepEqual(result.candidateSkipped, []);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
});

for (const objectType of ['account', 'engagement']) {
  test(`a confirmed ${objectType} assignment retains MS publication for reference mail`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run } = await fixture(t, {
      workspaceId, subject: '[광고] Example Project newsletter',
      body: 'Example Project weekly offers. Unsubscribe to stop receiving this newsletter.',
    });
    binding.companyMemory = { workspaceId, provider: 'outlook' };
    binding.workSystem.cwosClient.readMasters = async () => ({
      workspaceId, items: [{ objectType, externalId: 'confirmed-context', name: 'Example Project' }],
      provenance: { runtimeVersion: 4 },
    });
    await run();
    store.db.prepare("UPDATE mail_work_links SET status='confirmed', corrected_by='fixture-user'").run();
    const result = await run();
    assert.deepEqual(result.candidateSkipped, []);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM mail_work_links WHERE status='confirmed'").get().n, 1);
  });
}

test('unknown native version refuses delivery rather than fabricating CAS state', async (t) => {
  const { binding, run, posts } = await fixture(t);
  const read = binding.workSystem.cwosClient.readMasters;
  binding.workSystem.cwosClient.readMasters = async scope => {
    const result = await read(scope);
    delete result.provenance.runtimeVersion;
    return result;
  };
  const result = await run();
  assert.equal(result.failures[0].code, 'CWOS_CANDIDATE_INPUT_INVALID');
  assert.equal(posts.length, 0);
});

test('ambiguous existing local projects without candidate links do not append CRM candidates', async (t) => {
  const { binding, store, run, posts } = await fixture(t, {
    subject: 'Alpha Project / Beta Project information',
    body: 'FYI: Alpha Project and Beta Project.',
  });
  const mailbox = store.getMailbox('me');
  store.createProject(mailbox.id, { name: 'Alpha Project' });
  store.createProject(mailbox.id, { name: 'Beta Project' });
  binding.workSystem.cwosClient.readMasters = async () => ({
    workspaceId: 'fixture-workspace', items: [], provenance: { runtimeVersion: 4 },
  });
  const result = await run();
  assert.equal(store.getPrecisionClassification(mailbox.id, 'mail').projectResolution, 'review_required');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 0);
  assert.equal(result.deliveredCandidates.length, 0);
  assert.equal(posts.length, 0);
});
