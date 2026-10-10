import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMailSendApi } from '../src/application/mail-send-api.js';
import { canonicalize, commandDigest } from '../src/application/jarvis-receipt-gate.js';

const secret = 'synthetic-restricted-draft-token-0123456789';
const jarvisSecret = 'synthetic-jarvis-draft-token-0123456789abcdef';
const NOW = Date.parse('2026-10-02T01:00:00.000Z');
const DOMAIN = 'orca-jarvis/command-approval/v1\0';
const claims = Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: NOW / 1000 + 3600 })).toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519');

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let sends = 0;
  const api = createMailSendApi({
    getStore: () => ({ db }), getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null,
    readBody: async (req) => req.body,
    getAccessToken: async () => `fixture.${claims}.fixture`,
    serviceToken: secret, allowSend: true, accessKeyRequired: true,
    agentTokens: { jarvis: jarvisSecret },
    jarvisReceiptGate: true,
    jarvisDecisionPublicKey: publicPem,
    jarvisDecisionKeyId: 'decision-test',
    clientFactory: () => ({
      sendOnce: async () => { sends += 1; return { graphMessageId: 'fixture-sent', sentAt: '2026-10-02T01:00:00Z' }; },
      reconcile: async () => ({ uncertain: true }),
    }),
    ...options,
  });
  const call = (method, path, payload = {}, headers = {}) => api({ method, body: payload, headers }, new URL('http://127.0.0.1:3010/api/mail/send-drafts' + path));
  return {
    call, db, sends: () => sends,
    bot: { authorization: `Bearer ${secret}` },
    jarvis: { authorization: `Bearer ${jarvisSecret}` },
    human: { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' },
  };
}

function commandFor(draft, overrides = {}) {
  return {
    schema_version: 1, request_id: 'delegate-mail-01', action: 'external.delegate', action_level: 3,
    target: { environment: 'external', system: 'grok-bot' },
    args: { source: 'grok-bot', items: [{ action_kind: 'mail.send', summary: 'Fixture', payload_digest: `sha256:${draft.payload_digest}`, mail_draft_id: draft.draft_id }] },
    reversible: false, requested_by: 'agent:grok-bot', requested_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 3600_000).toISOString(), nonce: 'n',
    ...overrides,
  };
}

test('receipt approval never grants the JARVIS draft principal send authority', async (t) => {
  const f = fixture(t);
  const { body: { draft } } = await f.call('POST', '', {
    request_id: 'jarvis-own-draft', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
  }, f.jarvis);
  const command = commandFor(draft);
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, {
    confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command),
  }, f.jarvis), { code: 'HUMAN_APPROVAL_REQUIRED' });
  assert.equal(f.sends(), 0);
});

for (const field of ['requested_by', 'target', 'source']) {
  test(`receipt approval rejects a valid signature with a foreign ${field}`, async (t) => {
    const f = fixture(t);
    const { body: { draft } } = await f.call('POST', '', {
      request_id: 'foreign-authority-test', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
    }, f.bot);
    const command = commandFor(draft);
    if (field === 'requested_by') command.requested_by = 'agent:omonyang';
    if (field === 'target') command.target.system = 'omonyang';
    if (field === 'source') command.args.source = 'omonyang';
    await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, {
      confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command),
    }, f.bot), { code: 'JARVIS_RECEIPT_INVALID' });
    assert.equal(f.sends(), 0);
    assert.equal(f.db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id=?').get(draft.draft_id).status, 'needs_approval');
  });
}

for (const [name, times] of [
  ['expired', { requested_at: new Date(NOW - 3600_000).toISOString(), expires_at: new Date(NOW).toISOString() }],
  ['not yet requested', { requested_at: new Date(NOW + 60_000).toISOString() }],
  ['invalid expiry', { expires_at: 'not-a-date' }],
]) {
  test(`receipt approval rejects a command that is ${name}`, async (t) => {
    const f = fixture(t);
    const { body: { draft } } = await f.call('POST', '', {
      request_id: 'command-window-test', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
    }, f.bot);
    const command = commandFor(draft, times);
    await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, {
      confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command),
    }, f.bot), { code: 'JARVIS_RECEIPT_INVALID' });
    assert.equal(f.sends(), 0);
  });
}

test('receipt authority is rechecked after asynchronous send preflight', async (t) => {
  const f = fixture(t, { recheckDrive: async () => t.mock.timers.setTime(NOW + 31 * 60_000) });
  const { body: { draft } } = await f.call('POST', '', {
    request_id: 'preflight-expiry-test', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
  }, f.bot);
  const command = commandFor(draft);
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, {
    confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command),
  }, f.bot), { code: 'JARVIS_RECEIPT_INVALID' });
  assert.equal(f.sends(), 0);
});

test('failed durable claim rolls back receipt use and approval so the same request can retry', async (t) => {
  const f = fixture(t);
  const { body: { draft } } = await f.call('POST', '', {
    request_id: 'claim-rollback-test', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
  }, f.bot);
  f.db.exec(`CREATE TRIGGER fail_send_claim BEFORE UPDATE OF status ON mail_send_drafts
    WHEN NEW.status='sending' BEGIN SELECT RAISE(ABORT, 'synthetic claim failure'); END`);
  const command = commandFor(draft);
  const body = { confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command) };
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, body, f.bot), /synthetic claim failure/);
  assert.equal(f.db.prepare('SELECT status FROM mail_send_drafts WHERE draft_id=?').get(draft.draft_id).status, 'needs_approval');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM jarvis_receipt_uses').get().n, 0);
  assert.equal(f.sends(), 0);
  f.db.exec('DROP TRIGGER fail_send_claim');
  assert.equal((await f.call('POST', `/${draft.draft_id}/approve`, body, f.bot)).status, 200);
  assert.equal(f.sends(), 1);
});

test('matches the sha256-prefixed approval item to the native mail draft digest', async (t) => {
  const f = fixture(t);
  const { body: { draft } } = await f.call('POST', '', {
    request_id: 'digest-format-test', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.',
  }, f.bot);
  assert.match(draft.payload_digest, /^[0-9a-f]{64}$/);
  const command = commandFor(draft);
  command.args.items[0].payload_digest = `sha256:${draft.payload_digest}`;
  const result = await f.call('POST', `/${draft.draft_id}/approve`, {
    confirm: true, payload_digest: draft.payload_digest, command, receipt: receiptFor(command),
  }, f.bot);
  assert.equal(result.status, 200);
  assert.equal(f.sends(), 1);
});

function receiptFor(command, key = privateKey, keyId = 'decision-test') {
  const now = new Date();
  const payload = {
    schema_version: 1, receipt_id: 'rcpt:mail-1', request_id: command.request_id, decision: 'approve',
    command_digest: commandDigest(command), signer_principal_id: 'principal:owner', authenticated_session_id: 'session-1',
    key_id: keyId, algorithm: 'Ed25519', issued_at: now.toISOString(), not_before: now.toISOString(),
    expires_at: new Date(now.getTime() + 30 * 60_000).toISOString(), nonce: 'n1', max_uses: 1, status: 'issued',
  };
  const signature = sign(null, Buffer.from(DOMAIN + canonicalize(payload)), key).toString('base64url');
  return { ...payload, signature };
}

test('flag on accepts one real receipt for the draft digest and rejects a second and a foreign key', async (t) => {
  const f = fixture(t);
  const created = await f.call('POST', '', { request_id: 'api-request-001', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.' }, f.bot);
  const draft = created.body.draft;
  const command = {
    schema_version: 1, request_id: 'delegate-mail-01', action: 'external.delegate', action_level: 3,
    target: { environment: 'external', system: 'grok-bot' },
    args: { source: 'grok-bot', items: [{ action_kind: 'mail.send', summary: 'Fixture', payload_digest: `sha256:${draft.payload_digest}`, mail_draft_id: draft.draft_id }] },
    reversible: false, requested_by: 'agent:grok-bot', requested_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(), nonce: 'n',
  };
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.bot), { code: 'JARVIS_RECEIPT_INVALID' });
  const foreign = receiptFor(command, other.privateKey);
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest, receipt: foreign, command }, f.bot), { code: 'JARVIS_RECEIPT_INVALID' });
  const receipt = receiptFor(command);
  const approved = await f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest, receipt, command }, f.bot);
  assert.equal(approved.status, 200);
  assert.equal(f.sends(), 1);
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest, receipt, command }, f.bot), { code: 'RECEIPT_ALREADY_USED' });
  assert.equal(f.sends(), 1);
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human), { code: 'SECOND_APPROVAL_DISABLED' });
});

test('flag off still rejects a grok approve', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const api = createMailSendApi({
    getStore: () => ({ db }), getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: () => null, readBody: async (req) => req.body, getAccessToken: async () => 'x',
    serviceToken: secret, allowSend: false, accessKeyRequired: true,
  });
  const created = await api({ method: 'POST', body: { request_id: 'api-request-002', to: ['self@example.com'], subject: 'Fixture', body_text: 'no' }, headers: { authorization: `Bearer ${secret}` } }, new URL('http://127.0.0.1:3010/api/mail/send-drafts'));
  await assert.rejects(api({ method: 'POST', body: { confirm: true }, headers: { authorization: `Bearer ${secret}` } }, new URL(`http://127.0.0.1:3010/api/mail/send-drafts/${created.body.draft.draft_id}/approve`)), { code: 'HUMAN_APPROVAL_REQUIRED' });
});
