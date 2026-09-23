import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import {
  DRIVE_FILE_SCOPE,
  DRIVE_OPENID_SCOPES,
  GOOGLE_ACCOUNTS_ORIGIN,
  createGoogleDriveClient,
} from '../adapters/google-drive-client.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const FILE_ID = /^[A-Za-z0-9_-]{5,256}$/;
const ALLOWED_RETURN = new Set(['/', '/#sendDraftReview']);

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function encodeState() {
  return randomBytes(24).toString('base64url');
}

function codeVerifier() {
  return randomBytes(48).toString('base64url');
}

function challenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function sealSecret(key, plaintext, aad) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ciphertext.toString('base64'),
  });
}

export function openSecret(key, envelope, aad) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
  let parsed;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function verifyGoogleIdToken(idToken, {
  clientId,
  nonce,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  jwks: injectedJwks,
} = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) fail(403, 'DRIVE_ACCESS_DENIED');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || header.typ !== 'JWT') fail(403, 'DRIVE_ACCESS_DENIED');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) fail(403, 'DRIVE_ACCESS_DENIED');
  if (payload.aud !== clientId) fail(403, 'DRIVE_ACCESS_DENIED');
  if (!payload.sub || typeof payload.sub !== 'string') fail(403, 'DRIVE_ACCESS_DENIED');
  if (Number(payload.exp) * 1000 <= now()) fail(403, 'DRIVE_ACCESS_DENIED');
  if (nonce && payload.nonce !== nonce) fail(403, 'DRIVE_ACCESS_DENIED');
  const jwks = injectedJwks || await (async () => {
    const response = await fetchImpl('https://www.googleapis.com/oauth2/v3/certs', { redirect: 'manual' });
    if (!response.ok || response.status >= 300) fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
    return response.json();
  })();
  const jwk = (jwks.keys || []).find((item) => item.kid === header.kid);
  if (!jwk) fail(403, 'DRIVE_ACCESS_DENIED');
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) fail(403, 'DRIVE_ACCESS_DENIED');
  return payload;
}

export function createDriveConnectionService({
  db,
  getKey,
  client = createGoogleDriveClient(),
  now = () => new Date().toISOString(),
  pending = new Map(),
  verifyIdToken = verifyGoogleIdToken,
  driveEnabled = false,
  clientId = '',
  clientSecret = '',
  redirectUri = '',
} = {}) {
  function assertEnabled() {
    if (driveEnabled !== true || !clientId || !clientSecret || !redirectUri) fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
  }

  function prune() {
    const cutoff = Date.now() - STATE_TTL_MS;
    for (const [state, item] of pending) {
      if (!item || item.createdAt < cutoff) pending.delete(state);
    }
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function connectionRow(mailboxId, id) {
    const row = db.prepare(`
      SELECT * FROM mail_drive_connections WHERE id=? AND mailbox_id=? AND revoked_at IS NULL
    `).get(id, mailboxId);
    if (!row) fail(404, 'ASSET_NOT_FOUND');
    return row;
  }

  return {
    publicConnection(row) {
      return {
        id: row.id,
        mailbox_id: row.mailbox_id,
        connected: !row.revoked_at,
        scopes: row.scopes,
        created_at: row.created_at,
      };
    },

    listActive(mailboxId) {
      return db.prepare(`
        SELECT * FROM mail_drive_connections WHERE mailbox_id=? AND revoked_at IS NULL ORDER BY created_at DESC
      `).all(mailboxId).map((row) => this.publicConnection(row));
    },

    startConnect({ mailboxId, sessionToken, returnPath = '/' }) {
      assertEnabled();
      if (typeof sessionToken !== 'string' || !sessionToken) fail(401, 'AUTH_REQUIRED');
      if (!ALLOWED_RETURN.has(returnPath)) fail(400, 'INVALID_DRAFT_FIELDS');
      prune();
      const state = encodeState();
      const verifier = codeVerifier();
      const nonce = encodeState();
      pending.set(state, {
        mailboxId,
        sessionToken,
        verifier,
        nonce,
        returnPath,
        createdAt: Date.now(),
      });
      const authorize = new URL(`${GOOGLE_ACCOUNTS_ORIGIN}/o/oauth2/v2/auth`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('scope', DRIVE_OPENID_SCOPES.join(' '));
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('nonce', nonce);
      authorize.searchParams.set('code_challenge', challenge(verifier));
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('access_type', 'offline');
      authorize.searchParams.set('prompt', 'consent');
      authorize.searchParams.set('include_granted_scopes', 'false');
      return { authorization_url: authorize.toString(), state };
    },

    async finishCallback({ code, state, sessionToken, mailboxId, fetchImpl }) {
      assertEnabled();
      prune();
      const pendingState = pending.get(state);
      if (!pendingState || Date.now() - pendingState.createdAt > STATE_TTL_MS) {
        pending.delete(state);
        fail(403, 'FORBIDDEN');
      }
      if (pendingState.sessionToken !== sessionToken || Number(pendingState.mailboxId) !== Number(mailboxId)) fail(403, 'FORBIDDEN');
      if (typeof code !== 'string' || !code) fail(403, 'FORBIDDEN');
      pending.delete(state);
      const tokens = await client.exchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri,
        codeVerifier: pendingState.verifier,
      });
      const identity = await verifyIdToken(tokens.id_token, {
        clientId,
        nonce: pendingState.nonce,
        fetchImpl,
      });
      if (!tokens.refresh_token) fail(403, 'DRIVE_ACCESS_DENIED');
      const granted = String(tokens.scope || DRIVE_FILE_SCOPE).split(/[ ,]+/).filter(Boolean);
      if (!granted.includes(DRIVE_FILE_SCOPE)) fail(403, 'DRIVE_ACCESS_DENIED');
      if (granted.includes('https://www.googleapis.com/auth/drive')
        || granted.includes('https://www.googleapis.com/auth/drive.readonly')) {
        fail(403, 'DRIVE_ACCESS_DENIED');
      }
      const key = await getKey();
      return transaction(() => {
        const existing = db.prepare(`
          SELECT * FROM mail_drive_connections WHERE mailbox_id=? AND provider_subject=?
        `).get(mailboxId, identity.sub);
        const id = existing?.id || randomUUID();
        const envelope = sealSecret(key, tokens.refresh_token, `${id}|${mailboxId}|drive-refresh`);
        if (existing) {
          db.prepare(`
            UPDATE mail_drive_connections
            SET encrypted_refresh_token=?, scopes=?, revoked_at=NULL, created_at=?
            WHERE id=?
          `).run(envelope, DRIVE_FILE_SCOPE, now(), existing.id);
          return { connection: this.publicConnection(connectionRow(mailboxId, existing.id)), returnPath: pendingState.returnPath };
        }
        db.prepare(`
          INSERT INTO mail_drive_connections(id,mailbox_id,provider_subject,encrypted_refresh_token,scopes,created_at)
          VALUES (?,?,?,?,?,?)
        `).run(id, mailboxId, identity.sub, envelope, DRIVE_FILE_SCOPE, now());
        return { connection: this.publicConnection(connectionRow(mailboxId, id)), returnPath: pendingState.returnPath };
      });
    },

    async accessToken(mailboxId, connectionId) {
      assertEnabled();
      const row = connectionRow(mailboxId, connectionId);
      const key = await getKey();
      const refreshToken = openSecret(key, row.encrypted_refresh_token, `${row.id}|${mailboxId}|drive-refresh`);
      const tokens = await client.refreshAccessToken({ clientId, clientSecret, refreshToken });
      if (!tokens.access_token) fail(403, 'DRIVE_ACCESS_DENIED');
      return {
        access_token: tokens.access_token,
        expires_in: Number(tokens.expires_in || 300),
        token_type: 'Bearer',
      };
    },

    async recordSelection({ mailboxId, connectionId, fileId, resourceKey = '' }) {
      assertEnabled();
      if (!FILE_ID.test(fileId)) fail(422, 'UNSUPPORTED_FILE');
      const token = await this.accessToken(mailboxId, connectionId);
      const metadata = await client.getMetadata({
        accessToken: token.access_token,
        fileId,
        resourceKey: resourceKey || undefined,
      });
      if (metadata.trashed || metadata.capabilities?.canDownload !== true) fail(403, 'DRIVE_ACCESS_DENIED');
      const key = await getKey();
      const sealedKey = resourceKey ? sealSecret(key, resourceKey, `${connectionId}|${mailboxId}|${fileId}`) : null;
      transaction(() => {
        db.prepare(`
          INSERT INTO mail_drive_file_grants(connection_id,mailbox_id,file_id,resource_key_encrypted,selected_at,revoked_at)
          VALUES (?,?,?,?,?,NULL)
          ON CONFLICT(connection_id,file_id) DO UPDATE SET
            resource_key_encrypted=excluded.resource_key_encrypted,
            selected_at=excluded.selected_at,
            revoked_at=NULL
        `).run(connectionId, mailboxId, fileId, sealedKey, now());
      });
      return { connection_id: connectionId, file_id: fileId, selected: true };
    },

    requireGrant({ mailboxId, connectionId, fileId }) {
      const grant = db.prepare(`
        SELECT * FROM mail_drive_file_grants
        WHERE connection_id=? AND mailbox_id=? AND file_id=? AND revoked_at IS NULL
      `).get(connectionId, mailboxId, fileId);
      if (!grant) fail(403, 'DRIVE_ACCESS_DENIED');
      return grant;
    },

    async openResourceKey(grant) {
      if (!grant.resource_key_encrypted) return '';
      const key = await getKey();
      return openSecret(key, grant.resource_key_encrypted, `${grant.connection_id}|${grant.mailbox_id}|${grant.file_id}`);
    },

    disconnect({ mailboxId, connectionId }) {
      assertEnabled();
      return transaction(() => {
        connectionRow(mailboxId, connectionId);
        db.prepare('UPDATE mail_drive_file_grants SET revoked_at=? WHERE connection_id=? AND mailbox_id=? AND revoked_at IS NULL')
          .run(now(), connectionId, mailboxId);
        db.prepare('UPDATE mail_drive_connections SET revoked_at=?, encrypted_refresh_token=? WHERE id=? AND mailbox_id=?')
          .run(now(), '', connectionId, mailboxId);
        return { disconnected: true };
      });
    },

    async recheckAsset(mailboxId, asset) {
      if (asset.origin !== 'drive') return;
      if (!asset.drive_connection_id || !asset.drive_file_id) fail(409, 'DRIVE_SOURCE_CHANGED');
      let token;
      try {
        token = await this.accessToken(mailboxId, asset.drive_connection_id);
      } catch (error) {
        if (error?.code === 'ASSET_NOT_FOUND' || error?.code === 'DRIVE_ACCESS_DENIED') fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
        throw error;
      }
      const grant = this.requireGrant({
        mailboxId,
        connectionId: asset.drive_connection_id,
        fileId: asset.drive_file_id,
      });
      const resourceKey = await this.openResourceKey(grant);
      let metadata;
      try {
        metadata = await client.getMetadata({
          accessToken: token.access_token,
          fileId: asset.drive_file_id,
          resourceKey: resourceKey || undefined,
          timeout: 10_000,
        });
      } catch (error) {
        if (error?.code === 'DRIVE_ACCESS_DENIED') fail(403, 'DRIVE_ACCESS_DENIED');
        fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
      }
      if (metadata.trashed || metadata.capabilities?.canDownload !== true) fail(403, 'DRIVE_ACCESS_DENIED');
      if (String(metadata.version) !== String(asset.drive_version)) fail(409, 'DRIVE_SOURCE_CHANGED');
    },
  };
}
