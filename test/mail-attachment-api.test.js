import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createMailAttachmentApi, encodeUploadFileName } from '../src/application/mail-attachment-api.js';
import { createSyntheticPassScanner, createUnavailableScanner } from '../src/application/mail-attachment-assets.js';

const secret = 'synthetic-restricted-draft-token-0123456789';
const KEY = Buffer.alloc(32, 11);

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const api = createMailAttachmentApi({
    getStore: () => ({ db }),
    getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: (req) => (req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null),
    serviceToken: secret,
    attachmentsEnabled: true,
    getAttachmentKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    ...options,
  });
  const call = (method, path, { body, headers = {}, mailboxId } = {}) => {
    const req = { method, body, headers };
    const url = new URL('http://127.0.0.1:3010/api/mail/attachment-assets' + path);
    const invoked = mailboxId
      ? createMailAttachmentApi({
        getStore: () => ({ db }),
        getMailbox: () => ({ id: mailboxId, graphUser: 'other' }),
        getSession: (incoming) => (incoming.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null),
        serviceToken: secret,
        attachmentsEnabled: true,
        getAttachmentKey: async () => KEY,
        scanner: createSyntheticPassScanner(),
        ...options,
      })(req, url)
      : api(req, url);
    return invoked;
  };
  const human = {
    cookie: 'fixture-session',
    origin: 'http://127.0.0.1:3010',
    'x-csrf-token': 'fixture-csrf',
    'content-type': 'application/octet-stream',
  };
  const bot = { authorization: `Bearer ${secret}`, 'content-type': 'application/octet-stream' };
  return { db, call, human, bot };
}

function uploadHeaders(base, name = 'note.txt') {
  const bytes = Buffer.from('synthetic api fixture', 'utf8');
  return {
    bytes,
    headers: {
      ...base,
      'x-upload-request-id': randomUUID(),
      'x-file-name': encodeUploadFileName(name),
      'x-file-type': 'text/plain',
      'content-length': String(bytes.length),
    },
  };
}

test('human upload requires session, csrf and origin and returns public metadata', async (t) => {
  const f = fixture(t);
  const { bytes, headers } = uploadHeaders(f.human);
  await assert.rejects(f.call('POST', '', { body: bytes, headers: { ...headers, cookie: '' } }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(f.call('POST', '', { body: bytes, headers: { ...headers, 'x-csrf-token': '' } }), { code: 'CSRF_REQUIRED' });
  await assert.rejects(f.call('POST', '', { body: bytes, headers: { ...headers, origin: 'https://evil.example' } }), { code: 'ORIGIN_REJECTED' });
  const created = await f.call('POST', '', { body: Readable.from(bytes), headers });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, 'ready');
  assert.equal(created.body.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(created.body.name, 'note.txt');
});

test('identical request_id replays and different bytes conflict', async (t) => {
  const f = fixture(t);
  const { bytes, headers } = uploadHeaders(f.human);
  const first = await f.call('POST', '', { body: Readable.from(bytes), headers });
  const replay = await f.call('POST', '', { body: Readable.from(bytes), headers });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  await assert.rejects(
    f.call('POST', '', { body: Readable.from(Buffer.from('other')), headers }),
    { code: 'REQUEST_CONFLICT' },
  );
});

test('human can review bot-uploaded bytes in the same mailbox, but bearer access stays denied', async (t) => {
  const f = fixture(t);
  const { bytes, headers } = uploadHeaders(f.bot);
  const created = await f.call('POST', '', { body: Readable.from(bytes), headers });
  assert.equal(created.status, 201);
  await assert.rejects(f.call('GET', `/${created.body.id}/content`, { headers: f.bot }), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('GET', `/${created.body.id}/content`, { headers: { ...f.human, ...f.bot } }), { code: 'FORBIDDEN' });
  const downloaded = await f.call('GET', `/${created.body.id}/content`, { headers: f.human });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body, bytes);
  assert.match(downloaded.headers['Content-Disposition'], /attachment/);
  assert.equal(downloaded.headers['X-Content-Type-Options'], 'nosniff');
  await assert.rejects(
    f.call('GET', `/${created.body.id}/content`, { headers: f.human, mailboxId: 2 }),
    { code: 'ASSET_NOT_FOUND' },
  );
  await assert.rejects(
    f.call('POST', `/${created.body.id}/discard`, { headers: f.human, body: {} }),
    { code: 'ASSET_NOT_FOUND' },
  );
  f.db.prepare('UPDATE mail_attachment_assets SET state=? WHERE id=?').run('staged', created.body.id);
  await assert.rejects(
    f.call('GET', `/${created.body.id}/content`, { headers: f.human }),
    { code: 'ASSET_CHANGED' },
  );
});

test('human download is attachment/nosniff and foreign mailbox is hidden', async (t) => {
  const f = fixture(t);
  const { bytes, headers } = uploadHeaders(f.human, '검토.txt');
  const created = await f.call('POST', '', { body: Readable.from(bytes), headers });
  const downloaded = await f.call('GET', `/${created.body.id}/content`, { headers: f.human });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.raw, true);
  assert.equal(downloaded.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(downloaded.headers['Content-Disposition'], /attachment/);
  assert.deepEqual(downloaded.body, bytes);
  await assert.rejects(
    f.call('GET', `/${created.body.id}/content`, { headers: f.human, mailboxId: 2 }),
    { code: 'ASSET_NOT_FOUND' },
  );
});

test('disabled flag and unavailable scanner do not persist bytes', async (t) => {
  const disabled = fixture(t, { attachmentsEnabled: false });
  const first = uploadHeaders(disabled.human);
  await assert.rejects(
    disabled.call('POST', '', { body: Readable.from(first.bytes), headers: first.headers }),
    { code: 'ATTACHMENTS_DISABLED' },
  );
  const blocked = fixture(t, { scanner: createUnavailableScanner() });
  const second = uploadHeaders(blocked.human);
  await assert.rejects(
    blocked.call('POST', '', { body: Readable.from(second.bytes), headers: second.headers }),
    { code: 'SCANNER_UNAVAILABLE' },
  );
  assert.equal(blocked.db.prepare('SELECT count(*) n FROM mail_attachment_assets').get().n, 0);
});

test('discard expires an unlinked human asset', async (t) => {
  const f = fixture(t);
  const { bytes, headers } = uploadHeaders(f.human);
  const created = await f.call('POST', '', { body: Readable.from(bytes), headers });
  const discarded = await f.call('POST', `/${created.body.id}/discard`, { headers: f.human, body: {} });
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.state, 'expired');
});
