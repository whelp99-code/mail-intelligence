import { createHash } from 'node:crypto';

const SAFE_SCAN_STATES = new Set(['clean']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** Mail-side quarantine boundary. A missing scanner or parser never becomes clean. */
export class AttachmentPipeline {
  constructor({ db, now = () => new Date().toISOString(), maxBytes = 20 * 1024 * 1024 } = {}) {
    if (!db) throw new Error('db is required.');
    this.db = db;
    this.now = now;
    this.maxBytes = Math.max(1, Number(maxBytes) || 20 * 1024 * 1024);
  }

  quarantine({ attachmentId, mailboxId, bytes, contentType = '', name = '' }) {
    if (!Number.isSafeInteger(attachmentId) || !Number.isSafeInteger(mailboxId)) fail('INVALID_ATTACHMENT');
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
    if (data.length > this.maxBytes) fail('ATTACHMENT_TOO_LARGE');
    const now = this.now();
    const sha256 = createHash('sha256').update(data).digest('hex');
    this.db.prepare(`INSERT INTO mail_attachment_processing
      (attachment_id,mailbox_id,sha256,quarantine_state,scan_state,extraction_state,evidence_json,created_at,updated_at)
      VALUES (?,?,?,'quarantined','pending','not_requested',?,?,?)
      ON CONFLICT(attachment_id) DO UPDATE SET sha256=excluded.sha256,quarantine_state='quarantined',scan_state='pending',extraction_state='not_requested',evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
      .run(attachmentId, mailboxId, sha256, JSON.stringify({ contentType: String(contentType), name: String(name), byteLength: data.length }), now, now);
    return this.status(attachmentId, mailboxId);
  }

  recordScan({ attachmentId, mailboxId, state, scanner = '', version = '' }) {
    if (!['clean', 'infected', 'unavailable', 'unsupported', 'timeout'].includes(state)) fail('INVALID_SCAN_STATE');
    const row = this.status(attachmentId, mailboxId);
    if (!row || row.quarantine_state !== 'quarantined') fail('ATTACHMENT_NOT_QUARANTINED');
    const next = state === 'clean' ? 'pending' : 'rejected';
    this.db.prepare('UPDATE mail_attachment_processing SET scan_state=?, extraction_state=?, scanner=?, scanner_version=?, updated_at=? WHERE attachment_id=? AND mailbox_id=?')
      .run(state, next, String(scanner), String(version), this.now(), attachmentId, mailboxId);
    return this.status(attachmentId, mailboxId);
  }

  authorizeExtraction({ attachmentId, mailboxId, parser = '', version = '' }) {
    const row = this.status(attachmentId, mailboxId);
    if (!row) fail('ATTACHMENT_NOT_FOUND');
    if (row.quarantine_state !== 'quarantined' || !SAFE_SCAN_STATES.has(row.scan_state)) fail('ATTACHMENT_SCAN_REQUIRED');
    this.db.prepare('UPDATE mail_attachment_processing SET extraction_state=\'authorized\', parser=?, parser_version=?, updated_at=? WHERE attachment_id=? AND mailbox_id=?')
      .run(String(parser), String(version), this.now(), attachmentId, mailboxId);
    return this.status(attachmentId, mailboxId);
  }

  status(attachmentId, mailboxId) {
    return this.db.prepare('SELECT * FROM mail_attachment_processing WHERE attachment_id=? AND mailbox_id=?').get(attachmentId, mailboxId) || null;
  }

  canExpose(attachmentId, mailboxId) {
    const row = this.status(attachmentId, mailboxId);
    return Boolean(row && row.quarantine_state === 'quarantined' && row.scan_state === 'clean' && row.extraction_state === 'authorized');
  }
}
