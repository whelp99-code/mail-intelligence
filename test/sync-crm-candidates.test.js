import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  store.db.prepare('UPDATE messages SET is_draft=1 WHERE graph_id=\'mail\'').run();
  assert.equal((await run()).skipped[0].code, 'RECEIVED_MAIL_REQUIRED');
  store.db.prepare('UPDATE messages SET is_draft=0 WHERE graph_id=\'mail\'').run();
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
    const audit = store.db.prepare('SELECT payload_json FROM audit_events WHERE event_type=\'mail.intake.completed\' ORDER BY id DESC LIMIT 1').get();
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
    store.db.prepare('UPDATE mail_work_links SET status=\'confirmed\', corrected_by=\'fixture-user\'').run();
    const result = await run();
    assert.deepEqual(result.candidateSkipped, []);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links WHERE status=\'confirmed\'').get().n, 1);
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

test('unchanged mail is ingested once across repeated sync', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, { workspaceId });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  const first = await run();
  const second = await run();
  assert.equal(first.accepted, 1);
  assert.equal(first.deliveredCandidates.length, 1);
  assert.equal(second.accepted, 1);
  assert.equal(second.deliveredCandidates.length, 0);
  assert.deepEqual(second.failures, []);
  assert.equal(posts.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit_events WHERE event_type=\'mail.crm_candidate.delivered\'').get().n, 1);
});

test('unknown POST outcome blocks later sync and restart without a delivery receipt', async (t) => {
  const { store, binding, run } = await fixture(t);
  const calls = [];
  binding.candidateWriter.fetchImpl = async (_url, options) => {
    calls.push(options.method);
    throw new TypeError('Synthetic response loss after remote commit');
  };
  const first = await run();
  assert.equal(first.failures[0].code, 'CWOS_CANDIDATE_UNAVAILABLE');
  const second = await run();
  assert.deepEqual(calls, ['POST']);
  assert.equal(second.failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
  assert.equal(second.deliveredCandidates.length, 0);
  const databasePath = store.databasePath;
  store.close();
  const restartedProcess = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { SQLiteMailStore } from ${JSON.stringify(new URL('../src/storage/sqlite-store.js', import.meta.url).href)};
    import { createProductionIntakeBinding, ingestAfterCommittedSync } from ${JSON.stringify(new URL('../src/application/sync-work-intake.js', import.meta.url).href)};
    import { CwosMailCandidateWriter } from ${JSON.stringify(new URL('../src/adapters/cwos-mail-candidate-writer.js', import.meta.url).href)};
    const store = new SQLiteMailStore({ databasePath: process.argv[1] });
    try {
      let requests = 0;
      const binding = createProductionIntakeBinding({
        db: store.db, mailboxUser: 'me', workspaceId: 'fixture-workspace',
        readMasters: async () => ({ workspaceId: 'fixture-workspace',
          items: [{ objectType: 'engagement', externalId: 'project', name: 'Example Project' }],
          provenance: { runtimeVersion: 4 } }),
        candidateWriter: new CwosMailCandidateWriter({
          baseUrl: 'http://127.0.0.1', apiKey: 'fixture-writer-key-0123456789abcdef',
          workspaceId: 'fixture-workspace', principalId: 'writer', mailbox: 'delegate@example.invalid',
          fetchImpl: async () => { requests += 1; throw new Error('unexpected transport'); },
        }),
      });
      const result = await ingestAfterCommittedSync({ store, ...binding,
        mailboxUser: 'me', workspaceId: 'fixture-workspace', messageIds: ['mail'] });
      assert.equal(result.failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
      assert.equal(result.deliveredCandidates.length, 0);
      assert.equal(requests, 0);
      console.log('durable-fence-pass');
    } finally { store.close(); }
  `, databasePath], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.equal(restartedProcess.trim(), 'durable-fence-pass');
  const reopened = new SQLiteMailStore({ databasePath });
  t.after(() => reopened.close());
  const restarted = createProductionIntakeBinding({
    db: reopened.db, mailboxUser: 'me', workspaceId: 'fixture-workspace',
    readMasters: async () => ({
      workspaceId: 'fixture-workspace',
      items: [{ objectType: 'engagement', externalId: 'project', name: 'Example Project' }],
      provenance: { runtimeVersion: 4 },
    }),
    candidateWriter: binding.candidateWriter,
  });
  // A new revision must not bypass the unresolved outcome for this source.
  reopened.db.prepare('UPDATE messages SET change_key=\'v2\' WHERE graph_id=\'mail\'').run();
  const afterRestart = await ingestAfterCommittedSync({
    store: reopened, ...restarted, mailboxUser: 'me', workspaceId: 'fixture-workspace', messageIds: ['mail'],
  });
  assert.equal(afterRestart.failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
  assert.deepEqual(calls, ['POST']);
  assert.equal(afterRestart.deliveredCandidates.length, 0);
  assert.equal(reopened.latestAuditEvent('mail.crm_candidate.delivered', {
    entityType: 'message', entityId: 'mail',
  }), null);
});

for (const [name, respond, code] of [
  ['server failure', () => new Response('', { status: 500 }), 'CWOS_CANDIDATE_DENIED'],
  ['unexpected success', () => new Response('', { status: 202 }), 'CWOS_CANDIDATE_DENIED'],
  ['malformed receipt', () => new Response('{', { status: 201 }), 'CWOS_CANDIDATE_RESPONSE_INVALID'],
  ['mismatched receipt', () => Response.json({ candidate: {} }, { status: 201 }), 'CWOS_CANDIDATE_RECEIPT_MISMATCH'],
]) {
  test(`${name} remains unknown and cannot trigger another POST`, async (t) => {
    const { store, binding, run } = await fixture(t);
    let calls = 0;
    binding.candidateWriter.fetchImpl = async () => { calls += 1; return respond(); };
    assert.equal((await run()).failures[0].code, code);
    assert.equal((await run()).failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
    assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
  });
}

test('a known permission denial does not become an unknown outcome', async (t) => {
  const { binding, run, posts } = await fixture(t);
  const acceptedTransport = binding.candidateWriter.fetchImpl;
  binding.candidateWriter.fetchImpl = async () => new Response('', { status: 403 });
  assert.equal((await run()).failures[0].code, 'CWOS_CANDIDATE_DENIED');
  binding.candidateWriter.fetchImpl = acceptedTransport;
  const allowed = await run();
  assert.deepEqual(allowed.failures, []);
  assert.equal(allowed.deliveredCandidates.length, 1);
  assert.equal(posts.length, 1);
});

test('a concurrent sync cannot pass an in-flight durable dispatch fence', { timeout: 5000 }, async (t) => {
  const { binding, run } = await fixture(t);
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  binding.candidateWriter.fetchImpl = async () => {
    calls += 1;
    enter();
    await pending;
    throw new TypeError('Synthetic response loss');
  };
  const first = run();
  await entered;
  try {
    assert.equal((await run()).failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
  } finally {
    release();
    assert.equal((await first).failures[0].code, 'CWOS_CANDIDATE_UNAVAILABLE');
  }
});

test('failed durable reservation refuses transport before any POST', async (t) => {
  const { store, run, posts } = await fixture(t);
  const audit = store.audit.bind(store);
  store.audit = (event, detail) => {
    if (event === 'mail.crm_candidate.dispatch_started') throw Object.assign(new Error('fixture persistence failure'), { code: 'FIXTURE_PERSISTENCE_FAILED' });
    return audit(event, detail);
  };
  assert.equal((await run()).failures[0].code, 'FIXTURE_PERSISTENCE_FAILED');
  assert.equal(posts.length, 0);
});

test('failure to persist an accepted receipt keeps the outcome unknown', async (t) => {
  const { store, run, posts } = await fixture(t);
  const audit = store.audit.bind(store);
  store.audit = (event, detail) => {
    if (event === 'mail.crm_candidate.delivered') throw Object.assign(new Error('fixture receipt failure'), { code: 'FIXTURE_RECEIPT_FAILED' });
    return audit(event, detail);
  };
  const first = await run();
  assert.equal(first.failures[0].code, 'FIXTURE_RECEIPT_FAILED');
  assert.equal(first.deliveredCandidates.length, 0);
  store.audit = audit;
  assert.equal((await run()).failures[0].code, 'CWOS_CANDIDATE_OUTCOME_UNKNOWN');
  assert.equal(posts.length, 1);
  assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
});

test('a changed source revision delivers once more and a repeat of that revision does not', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run, posts } = await fixture(t, { workspaceId });
  binding.companyMemory = { workspaceId, provider: 'outlook' };
  await run();
  store.db.prepare('UPDATE messages SET change_key=\'v2\' WHERE graph_id=\'mail\'').run();
  const revised = await run();
  assert.equal(revised.deliveredCandidates.length, 1);
  assert.equal(posts.length, 2);
  const replay = await run();
  assert.equal(replay.deliveredCandidates.length, 0);
  assert.deepEqual(replay.failures, []);
  assert.equal(posts.length, 2);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_work_links').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_company_memory_outbox').get().n, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit_events WHERE event_type=\'mail.crm_candidate.delivered\'').get().n, 2);
});

function conflictWriter(onGet) {
  const calls = [];
  const posted = [];
  const writer = new CwosMailCandidateWriter({
    baseUrl: 'http://127.0.0.1', apiKey: 'fixture-writer-key-0123456789abcdef',
    workspaceId: '44444444-4444-4444-8444-444444444444', principalId: 'writer',
    mailbox: 'delegate@example.invalid',
    fetchImpl: async (url, options) => {
      const request = { path: url.pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null };
      calls.push(request);
      if (options.method === 'POST') {
        posted.push(request.body);
        return Response.json({ code: 'CWOS_CANDIDATE_CONFLICT' }, { status: 409 });
      }
      return onGet(posted.at(-1), url.pathname.split('/').at(-1));
    },
  });
  return { writer, calls, posted };
}

test('a 409 for an existing same-content candidate is recorded once and the next sync does not post', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run } = await fixture(t, { workspaceId });
  const { writer, calls } = conflictWriter((posted, id) => Response.json({
    workspaceId,
    runtimeVersion: 5,
    candidate: {
      id, providerEventId: posted.providerEventId, bodyDigest: posted.bodyDigest,
      subject: posted.subject, sourceLocator: posted.sourceLocator, mailbox: posted.mailbox,
      provider: posted.provider, createdByPrincipalId: 'writer',
      status: 'CANDIDATE', confirmed: false, freshness: 'producer_unverified',
      version: 1,
    },
  }));
  binding.candidateWriter = writer;
  const first = await run();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.match(calls.find(call => call.method === 'GET').path, /^\/api\/cwos\/v2\/mail-candidates\/mail-candidate-[a-f0-9]{64}$/);
  assert.equal(first.failures.length, 0);
  assert.equal(first.deliveredCandidates.length, 1);
  const audit = store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' });
  assert.equal(typeof audit.payload.sourceDigest, 'string');
  assert.equal(audit.payload.workspaceId, workspaceId);
  const second = await run();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(second.deliveredCandidates.length, 0);
  assert.deepEqual(second.failures, []);
});

test('a 409 with no candidate stays a dead letter and does not block a later create', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run } = await fixture(t, { workspaceId });
  const { writer, calls } = conflictWriter(() => Response.json({ error: 'MAIL_CANDIDATE_NOT_FOUND' }, { status: 404 }));
  binding.candidateWriter = writer;
  const first = await run();
  assert.equal(first.deliveredCandidates.length, 0);
  assert.equal(first.failures[0].code, 'CWOS_CANDIDATE_CONFLICT');
  assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
  const second = await run();
  assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(second.failures[0].code, 'CWOS_CANDIDATE_CONFLICT');
  assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
});

test('a 409 for different candidate content stays a dead letter', async (t) => {
  const workspaceId = '44444444-4444-4444-8444-444444444444';
  const { store, binding, run } = await fixture(t, { workspaceId });
  const { writer, calls } = conflictWriter((posted, id) => Response.json({
    workspaceId,
    runtimeVersion: 5,
    candidate: {
      id, providerEventId: posted.providerEventId, bodyDigest: 'e'.repeat(64),
      subject: posted.subject, sourceLocator: posted.sourceLocator, mailbox: posted.mailbox,
      provider: posted.provider, createdByPrincipalId: 'writer',
      status: 'CANDIDATE', confirmed: false, freshness: 'producer_unverified', version: 1,
    },
  }));
  binding.candidateWriter = writer;
  const result = await run();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(result.deliveredCandidates.length, 0);
  assert.equal(result.failures[0].code, 'CWOS_CANDIDATE_CONFLICT');
  assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
});

for (const field of ['provider', 'mailbox', 'sourceLocator', 'subject', 'status', 'confirmed']) {
  test(`a 409 missing ${field} is never audited as delivered`, async (t) => {
    const workspaceId = '44444444-4444-4444-8444-444444444444';
    const { store, binding, run } = await fixture(t, { workspaceId });
    const { writer } = conflictWriter((posted, id) => {
      const candidate = {
        ...posted, id, createdByPrincipalId: 'writer', status: 'CANDIDATE',
        confirmed: false, freshness: 'producer_unverified', version: 1,
      };
      delete candidate[field];
      return Response.json({ workspaceId, runtimeVersion: 5, candidate });
    });
    binding.candidateWriter = writer;
    const result = await run();
    assert.equal(result.deliveredCandidates.length, 0);
    assert.equal(result.failures[0].code, 'CWOS_CANDIDATE_CONFLICT');
    assert.equal(store.latestAuditEvent('mail.crm_candidate.delivered', { entityType: 'message', entityId: 'mail' }), null);
  });
}

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
