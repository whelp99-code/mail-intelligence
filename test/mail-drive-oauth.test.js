import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { DRIVE_FILE_SCOPE } from '../src/adapters/google-drive-client.js';
import {
  createDriveConnectionService,
  verifyGoogleIdToken,
} from '../src/application/mail-drive-connections.js';

const KEY = Buffer.alloc(32, 21);
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig', alg: 'RS256' };

function signJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), pair.privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE mailboxes(id INTEGER PRIMARY KEY); INSERT INTO mailboxes VALUES(1),(2);');
  db.exec(readFileSync(new URL('../migrations/005_mail_send_drafts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/006_mail_attachments.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/007_mail_drive_connections.sql', import.meta.url), 'utf8'));
  t.after(() => db.close());
  const pending = new Map();
  const tokens = {
    refresh_token: 'refresh-1',
    access_token: 'access-1',
    expires_in: 300,
    scope: DRIVE_FILE_SCOPE,
    id_token: '',
  };
  const service = createDriveConnectionService({
    db,
    getKey: async () => KEY,
    client: {
      exchangeCode: async () => tokens,
      refreshAccessToken: async () => tokens,
      getMetadata: async () => ({
        id: 'file1',
        name: 'note.pdf',
        mimeType: 'application/pdf',
        version: '9',
        trashed: false,
        capabilities: { canDownload: true },
      }),
    },
    pending,
    driveEnabled: true,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    redirectUri: 'http://127.0.0.1:3999/auth/google-drive/callback',
    verifyIdToken: async (idToken, options) => verifyGoogleIdToken(idToken, { ...options, jwks: { keys: [jwk] } }),
  });
  return { db, service, pending, tokens };
}

test('ID token verifies issuer, audience, expiry, nonce, and signature', async () => {
  const nonce = 'nonce-1';
  const token = signJwt({
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    sub: 'subject-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce,
  });
  const payload = await verifyGoogleIdToken(token, {
    clientId: 'client-1',
    nonce,
    jwks: { keys: [jwk] },
  });
  assert.equal(payload.sub, 'subject-1');
  await assert.rejects(verifyGoogleIdToken(token, {
    clientId: 'other',
    nonce,
    jwks: { keys: [jwk] },
  }), { code: 'DRIVE_ACCESS_DENIED' });
});

test('OAuth state is one-time, session and mailbox bound, and stores only refresh ciphertext', async (t) => {
  const { db, service, tokens } = fixture(t);
  const started = service.startConnect({ mailboxId: 1, sessionToken: 'session-a', returnPath: '/' });
  const authorize = new URL(started.authorization_url);
  assert.equal(authorize.searchParams.get('scope').includes(DRIVE_FILE_SCOPE), true);
  assert.equal(authorize.searchParams.get('scope').includes('drive.readonly'), false);
  const state = authorize.searchParams.get('state');
  tokens.id_token = signJwt({
    iss: 'https://accounts.google.com',
    aud: 'client-1',
    sub: 'subject-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: authorize.searchParams.get('nonce'),
  });
  await assert.rejects(service.finishCallback({
    code: 'code-1', state, sessionToken: 'session-b', mailboxId: 1,
  }), { code: 'FORBIDDEN' });
  await assert.rejects(service.finishCallback({
    code: 'code-1', state, sessionToken: 'session-a', mailboxId: 2,
  }), { code: 'FORBIDDEN' });
  const first = await service.finishCallback({
    code: 'code-1', state, sessionToken: 'session-a', mailboxId: 1,
  });
  const row = db.prepare('SELECT * FROM mail_drive_connections WHERE id=?').get(first.connection.id);
  assert.equal(row.provider_subject, 'subject-1');
  assert.equal(String(row.encrypted_refresh_token).includes('refresh-1'), false);
  await assert.rejects(service.finishCallback({
    code: 'code-1', state, sessionToken: 'session-a', mailboxId: 1,
  }), { code: 'FORBIDDEN' });
});
