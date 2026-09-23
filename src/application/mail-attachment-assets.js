import { createHash, randomUUID } from 'node:crypto';
import {
  decryptAttachment,
  encryptAttachment,
  ENCRYPTION_AAD_VERSION,
  ENCRYPTION_POLICY_VERSION,
} from '../storage/mail-attachment-crypto.js';
import { validateAttachment } from './attachment-policy.js';

export const SCAN_POLICY_VERSION = 'scan-policy-v1';
export const UNLINKED_TTL_MS = 24 * 60 * 60 * 1000;

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 2_097_152,
  maxAttachmentsPerDraft: 5,
  maxConcurrentUploads: 2,
  unlinkedQuotaBytes: 128 * 1024 * 1024,
  totalQuotaBytes: 512 * 1024 * 1024,
  maxFileNameBytes: 180,
});

const ALLOWED_EXTENSIONS = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.hwp', 'application/x-hwp'],
  ['.hwpx', 'application/hwp+zip'],
  ['.txt', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.png', 'image/png'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
]);

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

export function createUnavailableScanner() {
  return {
    async scan() {
      fail(503, 'SCANNER_UNAVAILABLE');
    },
  };
}

export function createSyntheticPassScanner({ engine = 'synthetic-pass', version = 'test-1' } = {}) {
  return {
    async scan() {
      return { result: 'PASS', engine, version };
    },
  };
}

export function normalizeAttachmentFileName(value) {
  if (typeof value !== 'string') fail(422, 'UNSUPPORTED_FILE');
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) fail(422, 'UNSUPPORTED_FILE');
  }
  const name = value.normalize('NFC').trim();
  if (!name || Buffer.byteLength(name, 'utf8') > ATTACHMENT_LIMITS.maxFileNameBytes) fail(422, 'UNSUPPORTED_FILE');
  if (/[\\/]/.test(name) || name.includes('..')) fail(422, 'UNSUPPORTED_FILE');
  return name;
}

export function mimeForAttachmentName(name) {
  const lower = name.toLowerCase();
  const index = lower.lastIndexOf('.');
  if (index <= 0) fail(422, 'UNSUPPORTED_FILE');
  const mime = ALLOWED_EXTENSIONS.get(lower.slice(index));
  if (!mime) fail(422, 'UNSUPPORTED_FILE');
  return mime;
}

export async function readBoundedOctetStream(body, maxBytes) {
  if (Buffer.isBuffer(body)) {
    if (body.length < 1) fail(422, 'UNSUPPORTED_FILE');
    if (body.length > maxBytes) fail(413, 'ATTACHMENT_TOO_LARGE');
    return body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) fail(413, 'ATTACHMENT_TOO_LARGE');
    chunks.push(part);
  }
  if (size < 1) fail(422, 'UNSUPPORTED_FILE');
  return Buffer.concat(chunks, size);
}

function publicAsset(row) {
  return {
    id: row.id,
    name: row.display_name,
    mime: row.mime_type,
    size: Number(row.byte_length),
    sha256: row.sha256,
    state: row.state,
    origin: row.origin,
    source: row.source,
    request_id: row.request_id,
    scan_engine: row.scan_engine,
    scan_version: row.scan_version,
    scan_policy_version: row.scan_policy_version,
    encryption_aad_version: row.encryption_aad_version,
    encryption_policy_version: row.encryption_policy_version,
    drive_connection_id: row.drive_connection_id || null,
    drive_file_id: row.drive_file_id || null,
    drive_version: row.drive_version ?? null,
    export_mime: row.export_mime ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export function createAttachmentAssetService({
  db,
  getKey,
  scanner = createUnavailableScanner(),
  validate = validateAttachment,
  attachmentsEnabled = false,
  now = () => new Date().toISOString(),
  limits = ATTACHMENT_LIMITS,
} = {}) {
  const settings = { ...ATTACHMENT_LIMITS, ...limits };

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

  function assertEnabled() {
    if (attachmentsEnabled !== true) fail(503, 'ATTACHMENTS_DISABLED');
  }

  function assertSource(source) {
    if (!['ui', 'grok-bot'].includes(source)) fail(400, 'INVALID_DRAFT_SOURCE');
  }

  function findByRequest(mailboxId, source, requestId) {
    return db.prepare(`
      SELECT * FROM mail_attachment_assets
      WHERE mailbox_id=? AND source=? AND request_id=? AND state <> 'expired'
    `).get(mailboxId, source, requestId) || null;
  }

  function visibleRow(mailboxId, id, source) {
    const row = db.prepare(`
      SELECT * FROM mail_attachment_assets
      WHERE mailbox_id=? AND id=? AND source=? AND state <> 'expired'
    `).get(mailboxId, id, source);
    if (!row) fail(404, 'ASSET_NOT_FOUND');
    return row;
  }

  function releaseReservation(reservationId) {
    if (!reservationId) return;
    db.prepare('UPDATE mail_attachment_reservations SET released_at=? WHERE id=? AND released_at IS NULL')
      .run(now(), reservationId);
  }

  function reserve({ mailboxId, source, requestId, reservedBytes }) {
    return transaction(() => {
      const active = Number(db.prepare(`
        SELECT count(*) n FROM mail_attachment_reservations
        WHERE mailbox_id=? AND released_at IS NULL
      `).get(mailboxId).n);
      if (active >= settings.maxConcurrentUploads) fail(429, 'IMPORT_CONCURRENCY_LIMIT');

      const reserved = Number(db.prepare(`
        SELECT COALESCE(SUM(reserved_bytes),0) n FROM mail_attachment_reservations
        WHERE mailbox_id=? AND released_at IS NULL
      `).get(mailboxId).n);
      const unlinked = Number(db.prepare(`
        SELECT COALESCE(SUM(a.byte_length),0) n
        FROM mail_attachment_assets a
        WHERE a.mailbox_id=?
          AND a.state IN ('staged','ready')
          AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM mail_draft_attachments d WHERE d.asset_id=a.id)
      `).get(mailboxId, now()).n);
      const total = Number(db.prepare(`
        SELECT COALESCE(SUM(byte_length),0) n
        FROM mail_attachment_assets
        WHERE mailbox_id=? AND state IN ('staged','ready')
      `).get(mailboxId).n);
      if (unlinked + reserved + reservedBytes > settings.unlinkedQuotaBytes) fail(507, 'ATTACHMENT_QUOTA_EXCEEDED');
      if (total + reserved + reservedBytes > settings.totalQuotaBytes) fail(507, 'ATTACHMENT_QUOTA_EXCEEDED');

      const id = randomUUID();
      try {
        db.prepare(`
          INSERT INTO mail_attachment_reservations(id,mailbox_id,source,request_id,reserved_bytes,created_at)
          VALUES (?,?,?,?,?,?)
        `).run(id, mailboxId, source, requestId, reservedBytes, now());
      } catch (error) {
        if (String(error?.message || '').includes('UNIQUE')) fail(409, 'REQUEST_CONFLICT');
        throw error;
      }
      return id;
    });
  }

  async function requireKey() {
    try {
      const key = await getKey();
      if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'ATTACHMENTS_DISABLED');
      return key;
    } catch (error) {
      if (error?.statusCode && error?.code) throw error;
      fail(503, 'ATTACHMENTS_DISABLED');
    }
  }

  return {
    limits: settings,

    async upload({
      mailboxId,
      source,
      requestId,
      displayName,
      declaredMime: _declaredMime,
      origin = 'local',
      contentLength,
      body,
      drive = null,
    }) {
      assertEnabled();
      assertSource(source);
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) fail(400, 'INVALID_REQUEST_ID');
      if (!['local', 'drive'].includes(origin)) fail(422, 'UNSUPPORTED_FILE');
      if (origin === 'drive' && (!drive || !drive.connectionId || !drive.fileId || !drive.version)) fail(422, 'UNSUPPORTED_FILE');
      const name = normalizeAttachmentFileName(displayName);
      const mime = mimeForAttachmentName(name);
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > 0 && declared > settings.maxFileBytes) fail(413, 'ATTACHMENT_TOO_LARGE');
      if (Number.isFinite(declared) && declared === 0) fail(422, 'UNSUPPORTED_FILE');

      const existing = findByRequest(mailboxId, source, requestId);
      const key = await requireKey();
      if (existing) {
        if (drive && (
          existing.drive_connection_id !== drive.connectionId
          || existing.drive_file_id !== drive.fileId
          || String(existing.drive_version) !== String(drive.version)
          || (existing.export_mime || null) !== (drive.exportMime || null)
        )) {
          fail(409, 'REQUEST_CONFLICT');
        }
        const bytes = await readBoundedOctetStream(body, settings.maxFileBytes);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest !== existing.sha256 || name !== existing.display_name || mime !== existing.mime_type) {
          fail(409, 'REQUEST_CONFLICT');
        }
        return { asset: publicAsset(existing), replay: true };
      }

      const reservedBytes = Number.isFinite(declared) && declared > 0 ? declared : settings.maxFileBytes;
      const reservationId = reserve({ mailboxId, source, requestId, reservedBytes });
      try {
        const bytes = await readBoundedOctetStream(body, settings.maxFileBytes);
        if (validate) validate({ bytes, displayName: name });
        const raced = findByRequest(mailboxId, source, requestId);
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (raced) {
          if (digest !== raced.sha256 || name !== raced.display_name) fail(409, 'REQUEST_CONFLICT');
          return { asset: publicAsset(raced), replay: true };
        }
        const scan = await scanner.scan({ bytes, name, mime });
        if (!scan || scan.result !== 'PASS') fail(422, 'UNSUPPORTED_FILE');
        const id = randomUUID();
        const sealed = encryptAttachment(bytes, {
          key,
          assetId: id,
          mailboxId,
          encryptionAadVersion: ENCRYPTION_AAD_VERSION,
          encryptionPolicyVersion: ENCRYPTION_POLICY_VERSION,
        });
        const expiresAt = new Date(Date.parse(now()) + UNLINKED_TTL_MS).toISOString();
        try {
          const created = transaction(() => {
            db.prepare(`
              INSERT INTO mail_attachment_assets(
                id,mailbox_id,source,request_id,display_name,mime_type,byte_length,sha256,
                ciphertext,nonce,auth_tag,key_version,encryption_aad_version,encryption_policy_version,
                scan_policy_version,state,scan_engine,scan_version,scanned_at,origin,created_at,expires_at,
                drive_connection_id,drive_file_id,drive_resource_key,drive_version,drive_modified_time,export_mime
              ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,?,?)
            `).run(
              id, mailboxId, source, requestId, name, mime, bytes.length, digest,
              sealed.ciphertext, sealed.nonce, sealed.authTag, sealed.keyVersion,
              sealed.encryptionAadVersion, sealed.encryptionPolicyVersion, SCAN_POLICY_VERSION,
              scan.engine || '', scan.version || '', now(), origin, now(), expiresAt,
              drive?.connectionId || null, drive?.fileId || null, drive?.resourceKey || null,
              drive?.version || null, drive?.modifiedTime || null, drive?.exportMime || null,
            );
            releaseReservation(reservationId);
            return publicAsset(visibleRow(mailboxId, id, source));
          });
          return { asset: created, replay: false };
        } catch (error) {
          const again = findByRequest(mailboxId, source, requestId);
          if (again && again.sha256 === digest && again.display_name === name) {
            releaseReservation(reservationId);
            return { asset: publicAsset(again), replay: true };
          }
          throw error;
        }
      } catch (error) {
        releaseReservation(reservationId);
        throw error;
      }
    },

    peekByRequest(mailboxId, source, requestId) {
      const row = findByRequest(mailboxId, source, requestId);
      return row ? publicAsset(row) : null;
    },

    get(mailboxId, id, { source } = {}) {
      assertEnabled();
      assertSource(source);
      return publicAsset(visibleRow(mailboxId, id, source));
    },

    async getContent(mailboxId, id, { source, actor } = {}) {
      assertEnabled();
      assertSource(source);
      if (actor !== 'human') fail(403, 'FORBIDDEN');
      const row = visibleRow(mailboxId, id, source);
      if (row.state !== 'ready') fail(409, 'ASSET_CHANGED');
      const key = await requireKey();
      const bytes = decryptAttachment({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        key,
        assetId: row.id,
        mailboxId: row.mailbox_id,
        encryptionAadVersion: row.encryption_aad_version,
        encryptionPolicyVersion: row.encryption_policy_version,
      });
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== row.sha256 || bytes.length !== Number(row.byte_length)) fail(409, 'ASSET_CHANGED');
      return { bytes, name: row.display_name, mime: row.mime_type };
    },

    discard(mailboxId, id, { source } = {}) {
      assertEnabled();
      assertSource(source);
      return transaction(() => {
        const row = visibleRow(mailboxId, id, source);
        const linked = db.prepare('SELECT 1 FROM mail_draft_attachments WHERE asset_id=?').get(id);
        if (linked) fail(409, 'DRAFT_IMMUTABLE');
        db.prepare('UPDATE mail_attachment_assets SET state=? WHERE id=?').run('expired', id);
        return { ...publicAsset(row), state: 'expired' };
      });
    },

    async decryptStored(row, { assetId, mailboxId }) {
      const key = await requireKey();
      return decryptAttachment({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        key,
        assetId,
        mailboxId,
        encryptionAadVersion: row.encryption_aad_version,
        encryptionPolicyVersion: row.encryption_policy_version,
      });
    },
  };
}
