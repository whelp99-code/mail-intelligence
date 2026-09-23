import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMailSendApi } from '../src/application/mail-send-api.js';
import { MailSendDrafts } from '../src/application/mail-send-drafts.js';

const secret = 'synthetic-restricted-draft-token-0123456789';
const body = { request_id: 'api-request-001', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.' };
const claims = Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url');
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let sends = 0;
  const api = createMailSendApi({
    getStore: () => ({ db }), getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null,
    readBody: async (req) => req.body,
    getAccessToken: async () => `fixture.${claims}.fixture`,
    serviceToken: secret, allowSend: true, accessKeyRequired: true,
    clientFactory: () => ({ sendOnce: async () => { sends++; await new Promise((resolve) => setTimeout(resolve, 10)); return { graphMessageId: 'fixture-sent', sentAt: '2026-09-09T01:00:00Z' }; }, reconcile: async () => ({ uncertain: true, failureCode: 'GRAPH_RECEIPT_PENDING' }) }),
    ...options,
  });
  const call = (method, path, payload = {}, headers = {}) => api({ method, body: payload, headers }, new URL('http://127.0.0.1:3010/api/mail/send-drafts' + path));
  const human = { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' };
  const bot = { authorization: `Bearer ${secret}` };
  return { db, call, human, bot, sends: () => sends };
}

test('bot creates needs_approval and reads only its drafts, never sends', async (t) => {
  const f = fixture(t);
  const created = await f.call('POST', '', body, f.bot);
  assert.equal(created.status, 201);
  assert.equal(created.body.draft.source, 'grok-bot');
  assert.equal(created.body.draft.status, 'needs_approval');
  assert.equal((await f.call('GET', '/' + created.body.draft.draft_id, {}, f.bot)).status, 200);
  assert.equal(f.sends(), 0);
  const ui = await f.call('POST', '', body, f.human);
  await assert.rejects(f.call('GET', '/' + ui.body.draft.draft_id, {}, f.bot), { code: 'DRAFT_NOT_FOUND' });
  await assert.rejects(f.call('GET', '', {}, f.bot), { code: 'DRAFT_LIST_FORBIDDEN' });
});

test('bot token cannot approve or cancel even with valid human cookie and csrf', async (t) => {
  const f = fixture(t);
  const draft = (await f.call('POST', '', body, f.bot)).body.draft;
  for (const action of ['approve', 'cancel']) {
    await assert.rejects(f.call('POST', `/${draft.draft_id}/${action}`, { confirm: true, payload_digest: draft.payload_digest }, { ...f.bot, ...f.human }), { statusCode: 403 });
  }
  assert.equal(f.sends(), 0);
});

test('flag OFF and missing Mail.Send scope both deny approval with no send', async (t) => {
  for (const [options, code] of [[{ allowSend: false }, 'MAIL_SEND_DISABLED'], [{ getAccessToken: async () => 'opaque' }, 'MAIL_SEND_SCOPE_REQUIRED']]) {
    const f = fixture(t, options);
    const draft = (await f.call('POST', '', body, f.bot)).body.draft;
    await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human), { code });
    assert.equal(f.sends(), 0);
  }
});

test('human approval enforces csrf, origin and explicit confirmation', async (t) => {
  const f = fixture(t);
  const draft = (await f.call('POST', '', body, f.bot)).body.draft;
  for (const headers of [{ ...f.human, 'x-csrf-token': '' }, { ...f.human, origin: 'https://evil.example' }, { ...f.human, cookie: '' }]) {
    await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, headers));
  }
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { payload_digest: draft.payload_digest }, f.human), { code: 'EXPLICIT_CONFIRMATION_REQUIRED' });
  assert.equal(f.sends(), 0);
});

test('simultaneous and repeated human approvals send once and persist receipt', async (t) => {
  const f = fixture(t);
  const draft = (await f.call('POST', '', body, f.bot)).body.draft;
  const approve = () => f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human);
  await Promise.all([approve(), approve()]);
  const result = await approve();
  assert.equal(result.body.draft.status, 'sent');
  assert.equal(result.body.draft.graph_message_id, 'fixture-sent');
  assert.equal(f.sends(), 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mail_send_draft_events WHERE status=?').get('approved').n, 1);
});

test('configured allowlist blocks a pre-existing pending draft before provider dispatch', async (t) => {
  const f = fixture(t, { recipientAllowlist: ['allowed@example.com'] });
  const draft = new MailSendDrafts(f.db).create(1, 'ui', {
    ...body,
    request_id: 'pre-policy-request-001',
    to: ['blocked@example.com'],
  }).draft;
  await assert.rejects(
    f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human),
    { code: 'RECIPIENT_NOT_ALLOWED' },
  );
  assert.equal(f.sends(), 0);
  assert.equal(new MailSendDrafts(f.db).get(1, draft.draft_id).status, 'needs_approval');
});

test('unauthenticated operator mode cannot enable approval', async (t) => {
  const f = fixture(t, { accessKeyRequired: false });
  const draft = (await f.call('POST', '', body, f.bot)).body.draft;
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human), { code: 'AUTHENTICATED_OPERATOR_REQUIRED' });
});

const jarvisSecret = 'synthetic-jarvis-draft-token-0123456789ab';

test('jarvis may create and read own draft status only', async (t) => {
  const f = fixture(t, { agentTokens: { 'grok-bot': secret, jarvis: jarvisSecret } });
  const jarvis = { authorization: `Bearer ${jarvisSecret}` };
  const created = await f.call('POST', '', { ...body, request_id: 'jarvis-request-001' }, jarvis);
  assert.equal(created.status, 201);
  assert.equal(created.body.draft.source, 'jarvis');
  assert.equal(created.body.draft.owner_principal, 'agent:jarvis');
  assert.equal((await f.call('GET', '/' + created.body.draft.draft_id, {}, jarvis)).status, 200);
  await assert.rejects(f.call('GET', '', {}, jarvis), { code: 'DRAFT_LIST_FORBIDDEN' });
  await assert.rejects(f.call('POST', `/${created.body.draft.draft_id}/approve`, { confirm: true, payload_digest: created.body.draft.payload_digest }, jarvis), { code: 'HUMAN_APPROVAL_REQUIRED' });
  await assert.rejects(f.call('POST', `/${created.body.draft.draft_id}/cancel`, {}, jarvis), { code: 'HUMAN_APPROVAL_REQUIRED' });
  assert.equal(f.sends(), 0);
});

test('other-agent read, stolen token, and human spoof are rejected', async (t) => {
  const f = fixture(t, { agentTokens: { 'grok-bot': secret, jarvis: jarvisSecret } });
  const jarvis = { authorization: `Bearer ${jarvisSecret}` };
  const grokDraft = (await f.call('POST', '', body, f.bot)).body.draft;
  const jarvisDraft = (await f.call('POST', '', { ...body, request_id: 'jarvis-request-002' }, jarvis)).body.draft;
  await assert.rejects(f.call('GET', '/' + grokDraft.draft_id, {}, jarvis), { code: 'DRAFT_NOT_FOUND' });
  await assert.rejects(f.call('GET', '/' + jarvisDraft.draft_id, {}, f.bot), { code: 'DRAFT_NOT_FOUND' });
  await assert.rejects(f.call('POST', '', body, { authorization: 'Bearer stolen-token-that-is-long-enough-0123' }), { code: 'DRAFT_TOKEN_REQUIRED' });
  await assert.rejects(
    f.call('POST', `/${grokDraft.draft_id}/approve`, { confirm: true, payload_digest: grokDraft.payload_digest }, { ...f.human, authorization: `Bearer ${jarvisSecret}` }),
    { code: 'HUMAN_APPROVAL_REQUIRED' },
  );
  const approved = await f.call('POST', `/${jarvisDraft.draft_id}/approve`, { confirm: true, payload_digest: jarvisDraft.payload_digest }, f.human);
  assert.equal(approved.body.draft.status, 'sent');
});
