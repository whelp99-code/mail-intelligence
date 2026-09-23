import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMailSendApi } from '../src/application/mail-send-api.js';
import {
  createAttachmentAssetService,
  createSyntheticPassScanner,
} from '../src/application/mail-attachment-assets.js';

const secret = 'synthetic-restricted-draft-token-0123456789';
const body = { request_id: 'api-request-001', to: ['self@example.com'], subject: 'Fixture', body_text: 'Synthetic only.' };
const claims = Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url');
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  let sends = 0;
  const sentAttachments = [];
  const ATTACH_KEY = Buffer.alloc(32, 17);
  const api = createMailSendApi({
    getStore: () => ({ db }), getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null,
    readBody: async (req) => req.body,
    getAccessToken: async () => `fixture.${claims}.fixture`,
    serviceToken: secret, allowSend: true, accessKeyRequired: true,
    getAttachmentKey: async () => ATTACH_KEY,
    clientFactory: () => ({
      sendOnce: async (_draft, sendOptions = {}) => {
        sends++;
        sentAttachments.push(sendOptions.attachments || []);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { graphMessageId: 'fixture-sent', sentAt: '2026-09-09T01:00:00Z' };
      },
      reconcile: async () => ({ uncertain: true, failureCode: 'GRAPH_RECEIPT_PENDING' }),
    }),
    ...options,
  });
  const call = (method, path, payload = {}, headers = {}) => api({ method, body: payload, headers }, new URL('http://127.0.0.1:3010/api/mail/send-drafts' + path));
  const human = { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' };
  const bot = { authorization: `Bearer ${secret}` };
  return { db, call, human, bot, sends: () => sends, sentAttachments, ATTACH_KEY };
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

test('unauthenticated operator mode cannot enable approval', async (t) => {
  const f = fixture(t, { accessKeyRequired: false });
  const draft = (await f.call('POST', '', body, f.bot)).body.draft;
  await assert.rejects(f.call('POST', `/${draft.draft_id}/approve`, { confirm: true, payload_digest: draft.payload_digest }, f.human), { code: 'AUTHENTICATED_OPERATOR_REQUIRED' });
});

async function uploadUiAsset(f, bytes = Buffer.from('api-attached', 'utf8'), name = 'note.txt') {
  const assets = createAttachmentAssetService({
    db: f.db,
    getKey: async () => f.ATTACH_KEY,
    scanner: createSyntheticPassScanner(),
    attachmentsEnabled: true,
  });
  const result = await assets.upload({
    mailboxId: 1,
    source: 'ui',
    requestId: randomUUID(),
    displayName: name,
    declaredMime: 'text/plain',
    origin: 'local',
    contentLength: bytes.length,
    body: Readable.from(bytes),
  });
  return { asset: result.asset, bytes };
}

test('approved attachment draft sends the verified buffer once and rejects tamper', async (t) => {
  const f = fixture(t);
  const { asset, bytes } = await uploadUiAsset(f);
  const created = await f.call('POST', '', { ...body, request_id: 'api-request-attach', attachment_ids: [asset.id] }, f.human);
  assert.equal(created.body.draft.digest_version, 2);
  assert.equal(created.body.draft.attachments[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  const approved = await f.call('POST', `/${created.body.draft.draft_id}/approve`, { confirm: true, payload_digest: created.body.draft.payload_digest }, f.human);
  assert.equal(approved.body.draft.status, 'sent');
  assert.equal(f.sends(), 1);
  assert.deepEqual(f.sentAttachments[0][0].bytes, bytes);

  const again = await uploadUiAsset(f, Buffer.from('second'), 'two.txt');
  const other = await f.call('POST', '', { ...body, request_id: 'api-request-tamper', attachment_ids: [again.asset.id] }, f.human);
  f.db.prepare('UPDATE mail_attachment_assets SET sha256=? WHERE id=?').run('11'.repeat(32), again.asset.id);
  await assert.rejects(
    f.call('POST', `/${other.body.draft.draft_id}/approve`, { confirm: true, payload_digest: other.body.draft.payload_digest }, f.human),
    { code: 'ASSET_CHANGED' },
  );
  assert.equal(f.sends(), 1);
});
