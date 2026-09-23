import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createMailDriveApi } from '../src/application/mail-drive-api.js';
import { createDriveConnectionService, sealSecret } from '../src/application/mail-drive-connections.js';
import { createSyntheticPassScanner } from '../src/application/mail-attachment-assets.js';
import { DRIVE_FILE_SCOPE } from '../src/adapters/google-drive-client.js';
import { createMailSendApi } from '../src/application/mail-send-api.js';

const KEY = Buffer.alloc(32, 23);
const secret = 'synthetic-restricted-draft-token-0123456789';
const pdf = Buffer.from('%PDF-1.4 drive-fixture', 'utf8');

function fixture(t, google = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2); CREATE TABLE messages(id INTEGER PRIMARY KEY,mailbox_id INTEGER,deleted_at TEXT,subject TEXT,web_link TEXT);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/009_mail_send_draft_principals.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/007_mail_drive_connections.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const files = new Map([
    ['file1', {
      id: 'file1',
      name: 'Spec.pdf',
      mimeType: 'application/pdf',
      version: '11',
      modifiedTime: '2026-09-10T00:00:00Z',
      trashed: false,
      capabilities: { canDownload: true },
      bytes: pdf,
    }],
    ['nodown', {
      id: 'nodown',
      name: 'Locked.pdf',
      mimeType: 'application/pdf',
      version: '2',
      modifiedTime: '2026-09-10T00:00:00Z',
      trashed: false,
      capabilities: { canDownload: false },
      bytes: pdf,
    }],
    ['doc01', {
      id: 'doc01',
      name: 'Minutes',
      mimeType: 'application/vnd.google-apps.document',
      version: '4',
      modifiedTime: '2026-09-10T00:00:00Z',
      trashed: false,
      capabilities: { canDownload: true },
      bytes: pdf,
    }],
  ]);
  const client = {
    exchangeCode: async () => ({ refresh_token: 'r', access_token: 'a', scope: DRIVE_FILE_SCOPE, id_token: 'id' }),
    refreshAccessToken: async () => ({ access_token: 'a', expires_in: 300 }),
    getMetadata: async ({ fileId }) => {
      const file = files.get(fileId) || google.files?.[fileId];
      if (!file || file.denied) {
        const error = new Error('DRIVE_ACCESS_DENIED');
        error.code = 'DRIVE_ACCESS_DENIED';
        error.statusCode = 403;
        throw error;
      }
      const meta = { ...file };
      delete meta.bytes;
      return meta;
    },
    download: async ({ fileId }) => {
      const file = files.get(fileId);
      if (!file) {
        const error = new Error('DRIVE_ACCESS_DENIED');
        error.code = 'DRIVE_ACCESS_DENIED';
        error.statusCode = 403;
        throw error;
      }
      return file.bytes;
    },
    exportFile: async ({ fileId, exportMime }) => {
      const file = files.get(fileId);
      if (!file) {
        const error = new Error('DRIVE_ACCESS_DENIED');
        error.code = 'DRIVE_ACCESS_DENIED';
        error.statusCode = 403;
        throw error;
      }
      if (exportMime === 'application/msword') {
        const error = new Error('EXPORT_UNSUPPORTED');
        error.code = 'EXPORT_UNSUPPORTED';
        error.statusCode = 422;
        throw error;
      }
      return file.bytes;
    },
    ...google.client,
  };
  const connections = createDriveConnectionService({
    db,
    getKey: async () => KEY,
    client,
    driveEnabled: true,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    redirectUri: 'http://127.0.0.1:3999/auth/google-drive/callback',
    verifyIdToken: async () => ({ sub: 'subject-1' }),
  });
  db.prepare(`
    INSERT INTO mail_drive_connections(id,mailbox_id,provider_subject,encrypted_refresh_token,scopes,created_at)
    VALUES (?,?,?,?,?,?)
  `).run(
    '11111111-1111-4111-8111-111111111111',
    1,
    'subject-1',
    sealSecret(KEY, 'refresh-1', '11111111-1111-4111-8111-111111111111|1|drive-refresh'),
    DRIVE_FILE_SCOPE,
    '2026-09-10T00:00:00.000Z',
  );
  const api = createMailDriveApi({
    getStore: () => ({ db }),
    getMailbox: () => ({ id: 1 }),
    getSession: (req) => (req.headers.cookie === 'fixture-session' ? { token: 'fixture-session', csrfToken: 'fixture-csrf' } : null),
    readBody: async (req) => req.body,
    serviceToken: secret,
    attachmentsEnabled: true,
    driveEnabled: true,
    getAttachmentKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    connections,
    client,
  });
  const call = (method, path, payload = {}, headers = {}) => api({
    method,
    body: payload,
    headers,
  }, new URL('http://127.0.0.1:3010/api/mail/drive/' + path));
  const human = { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' };
  const bot = { authorization: `Bearer ${secret}` };
  return { db, api, call, human, bot, connections, client, files };
}

test('human can select and import an allowlisted Drive file into a scanned asset', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call('POST', 'import', {
    request_id: randomUUID(),
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.human), { code: 'DRIVE_ACCESS_DENIED' });
  const selected = await f.call('POST', 'selection', {
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.human);
  assert.equal(selected.body.selected, true);
  const imported = await f.call('POST', 'import', {
    request_id: '11111111-1111-4111-8111-111111111112',
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.human);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.state, 'ready');
  assert.equal(imported.body.name, 'Spec.pdf');
  const replay = await f.call('POST', 'import', {
    request_id: '11111111-1111-4111-8111-111111111112',
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.human);
  assert.equal(replay.body.replay, true);
  await assert.rejects(f.call('POST', 'import', {
    request_id: '11111111-1111-4111-8111-111111111112',
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
    export_mime: 'application/pdf',
  }, f.human), { code: 'REQUEST_CONFLICT' });
});

test('unselected IDs, other-mailbox grants, disconnect, and bot-only routes fail closed', async (t) => {
  const f = fixture(t);
  await f.call('POST', 'selection', {
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.human);
  await assert.rejects(f.call('POST', 'import', {
    request_id: randomUUID(),
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'missing1',
  }, f.human), { code: 'DRIVE_ACCESS_DENIED' });
  await assert.rejects(f.call('POST', 'connect', { return_path: '/' }, f.bot), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('POST', 'selection', {
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.bot), { code: 'FORBIDDEN' });
  await assert.rejects(f.call('POST', 'picker-token', {
    connection_id: '11111111-1111-4111-8111-111111111111',
  }, f.bot), { code: 'FORBIDDEN' });
  const other = createMailDriveApi({
    getStore: () => ({ db: f.db }),
    getMailbox: () => ({ id: 2 }),
    getSession: () => ({ token: 'other', csrfToken: 'csrf' }),
    readBody: async (req) => req.body,
    attachmentsEnabled: true,
    driveEnabled: true,
    getAttachmentKey: async () => KEY,
    scanner: createSyntheticPassScanner(),
    connections: f.connections,
    client: f.client,
  });
  await assert.rejects(other({
    method: 'POST',
    body: { connection_id: '11111111-1111-4111-8111-111111111111', file_id: 'file1' },
    headers: { origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'csrf' },
  }, new URL('http://127.0.0.1:3010/api/mail/drive/selection')), { code: 'ASSET_NOT_FOUND' });
  await f.call('POST', 'disconnect', {
    connection_id: '11111111-1111-4111-8111-111111111111',
  }, f.human);
  await assert.rejects(f.call('POST', 'import', {
    request_id: randomUUID(),
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'file1',
  }, f.bot), { code: 'DRIVE_ACCESS_DENIED' });
});

test('Google Docs export is allowlisted and source-version change blocks approval', async (t) => {
  const f = fixture(t);
  await f.call('POST', 'selection', {
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'doc01',
  }, f.human);
  const imported = await f.call('POST', 'import', {
    request_id: '11111111-1111-4111-8111-111111111113',
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'doc01',
    export_mime: 'application/pdf',
  }, f.human);
  assert.equal(imported.body.name, 'Minutes.pdf');
  await assert.rejects(f.call('POST', 'import', {
    request_id: randomUUID(),
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'doc01',
    export_mime: 'application/msword',
  }, f.human), { code: 'EXPORT_UNSUPPORTED' });
  const send = createMailSendApi({
    getStore: () => ({ db: f.db }),
    getMailbox: () => ({ id: 1, graphUser: 'me' }),
    getSession: () => ({ token: 'fixture-session', csrfToken: 'fixture-csrf' }),
    readBody: async (req) => req.body,
    getAccessToken: async () => `fixture.${Buffer.from(JSON.stringify({ scp: 'Mail.Read Mail.Send', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.fixture`,
    allowSend: true,
    accessKeyRequired: true,
    getAttachmentKey: async () => KEY,
    recheckDrive: async (draft) => {
      for (const item of draft.attachments) await f.connections.recheckAsset(1, item);
    },
    clientFactory: () => ({ sendOnce: async () => ({ graphMessageId: 'x', sentAt: '2026-09-10T00:00:00Z' }), reconcile: async () => ({}) }),
  });
  const created = await send({
    method: 'POST',
    body: {
      request_id: 'drive-send-1',
      to: ['self@example.com'],
      subject: 'Drive',
      body_text: 'Synthetic only.',
      attachment_ids: [imported.body.id],
    },
    headers: { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' },
  }, new URL('http://127.0.0.1:3010/api/mail/send-drafts'));
  await assert.rejects(f.call('POST', 'selection', {
    connection_id: '11111111-1111-4111-8111-111111111111',
    file_id: 'nodown',
  }, f.human), { code: 'DRIVE_ACCESS_DENIED' });
  f.files.get('doc01').version = 'changed';
  await assert.rejects(send({
    method: 'POST',
    body: { payload_digest: created.body.draft.payload_digest, confirm: true },
    headers: { cookie: 'fixture-session', origin: 'http://127.0.0.1:3010', 'x-csrf-token': 'fixture-csrf' },
  }, new URL(`http://127.0.0.1:3010/api/mail/send-drafts/${created.body.draft.draft_id}/approve`)), { code: 'DRIVE_SOURCE_CHANGED' });
});
