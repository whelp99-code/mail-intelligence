import { createHash, randomUUID } from 'node:crypto';
import {
  assertMailSendRecipientsAllowed,
  normalizeMailSendRecipientAllowlist,
} from '../security/mail-send-recipient-policy.js';
import { enqueueSentDraftCompanyMemoryOutbox } from './company-memory-donor.js';
import { decryptAttachment } from '../storage/mail-attachment-crypto.js';
import { digestDriveLinks, normalizeDriveLinks, renderDriveLinks } from './drive-links.js';
import { ATTACHMENT_LIMITS, SCAN_POLICY_VERSION } from './mail-attachment-assets.js';

const GRAPH_SERIALIZED_LIMIT = Math.floor(3.5 * 1024 * 1024);
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(statusCode, code) {
  const error = new Error(code);
  Object.assign(error, { statusCode, code });
  throw error;
}

function addresses(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail(400, 'INVALID_RECIPIENTS');
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || item.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(item)) {
      fail(400, 'INVALID_RECIPIENT');
    }
    return item.toLowerCase();
  }))];
}

function text(value, max, singleLine = false) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max || value.includes(String.fromCharCode(0)) || (singleLine && /[\r\n]/.test(value))) {
    fail(400, 'INVALID_DRAFT_TEXT');
  }
  return value.trim();
}

function attachmentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.maxAttachmentsPerDraft) fail(422, 'UNSUPPORTED_FILE');
  const ids = value.map((item) => {
    if (typeof item !== 'string' || !ASSET_ID.test(item)) fail(400, 'INVALID_DRAFT_FIELDS');
    return item;
  });
  if (new Set(ids).size !== ids.length) fail(400, 'INVALID_DRAFT_FIELDS');
  return ids;
}

export function canonicalSendPayload({ to, cc, subject, body_text, message_id, attachments = [], links = [] }) {
  if (!attachments.length && !links.length) {
    return { version: 1, body: { to, cc, subject, body_text, message_id } };
  }
  return {
    version: 2,
    body: {
      version: 2,
      to,
      cc,
      subject,
      body_text,
      message_id,
      attachments: attachments.map((item, ordinal) => ({
        ordinal,
        id: item.id,
        name: item.name,
        mime: item.mime,
        size: item.size,
        sha256: item.sha256,
        origin: item.origin,
        drive_version: item.drive_version ?? null,
        export_mime: item.export_mime ?? null,
      })),
      links: links.map((item) => ({
        url: item.url,
        label: item.label,
        access_acknowledged: item.access_acknowledged,
      })),
    },
  };
}

export function digestCanonical(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export class MailSendDrafts {
  constructor(db, { now = () => new Date().toISOString(), recipientAllowlist = null, companyMemory = null } = {}) {
    this.db = db;
    this.now = now;
    this.recipientAllowlist = normalizeMailSendRecipientAllowlist(recipientAllowlist);
    this.companyMemory = companyMemory && typeof companyMemory === 'object' ? companyMemory : null;
  }

  assertRecipientsAllowed(draft) {
    assertMailSendRecipientsAllowed(this.recipientAllowlist, draft);
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  event(id, status, actor, reason = '') {
    this.db.prepare('INSERT INTO mail_send_draft_events(draft_id,status,actor,created_at,reason) VALUES (?,?,?,?,?)')
      .run(id, status, actor, this.now(), reason);
  }

  hasReconciliationQueue() {
    return Boolean(this.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=\'mail_send_reconciliation_jobs\'').get());
  }

  enqueueReconciliation(draft, { failureCode = '' } = {}) {
    if (!this.hasReconciliationQueue() || draft.status !== 'sending') return;
    const now = this.now();
    this.db.prepare(`
      INSERT INTO mail_send_reconciliation_jobs
        (draft_id, mailbox_id, state, next_attempt_at, last_failure_code, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET
        state=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.state ELSE 'pending' END,
        next_attempt_at=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.next_attempt_at ELSE excluded.next_attempt_at END,
        last_failure_code=CASE WHEN excluded.last_failure_code <> '' THEN excluded.last_failure_code ELSE mail_send_reconciliation_jobs.last_failure_code END,
        lease_owner=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.lease_owner ELSE '' END,
        lease_expires_at=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.lease_expires_at ELSE NULL END,
        updated_at=excluded.updated_at
    `).run(draft.draft_id, draft.mailbox_id, now, String(failureCode), now, now);
  }

  attachmentRows(draftId) {
    return this.db.prepare(`
      SELECT d.ordinal, d.asset_id, d.frozen_name, d.frozen_mime, d.frozen_size, d.frozen_sha256,
             a.origin, a.state, a.sha256, a.display_name, a.mime_type, a.byte_length,
             a.ciphertext, a.nonce, a.auth_tag, a.encryption_aad_version, a.encryption_policy_version,
             a.scan_policy_version, a.scan_engine, a.scan_version, a.drive_version, a.export_mime,
             a.drive_connection_id, a.drive_file_id, a.mailbox_id
      FROM mail_draft_attachments d
      JOIN mail_attachment_assets a ON a.id = d.asset_id
      WHERE d.draft_id=?
      ORDER BY d.ordinal
    `).all(draftId);
  }

  publicAttachments(draftId) {
    return this.attachmentRows(draftId).map((row) => ({
      ordinal: row.ordinal,
      id: row.asset_id,
      name: row.frozen_name,
      mime: row.frozen_mime,
      size: Number(row.frozen_size),
      sha256: row.frozen_sha256,
      origin: row.origin,
      state: row.state,
      scan_engine: row.scan_engine,
      scan_version: row.scan_version,
      drive_version: row.drive_version ?? null,
      export_mime: row.export_mime ?? null,
      drive_connection_id: row.drive_connection_id || null,
      drive_file_id: row.drive_file_id || null,
    }));
  }

  get(mailboxId, id) {
    const row = this.db.prepare('SELECT * FROM mail_send_drafts WHERE mailbox_id=? AND draft_id=?').get(mailboxId, id);
    if (!row) fail(404, 'DRAFT_NOT_FOUND');
    const { to_json: toJson, cc_json: ccJson, links_json: linksJson, ...result } = row;
    return {
      ...result,
      to: JSON.parse(toJson),
      cc: JSON.parse(ccJson),
      links: JSON.parse(linksJson || '[]'),
      digest_version: Number(row.digest_version || 1),
      attachments: this.publicAttachments(id),
    };
  }

  list(mailboxId) {
    return this.db.prepare('SELECT draft_id FROM mail_send_drafts WHERE mailbox_id=? ORDER BY created_at DESC LIMIT 100')
      .all(mailboxId).map((row) => this.get(mailboxId, row.draft_id));
  }

  loadBoundAssets(mailboxId, source, ids) {
    const assets = [];
    let total = 0;
    ids.forEach((id, ordinal) => {
      const row = this.db.prepare(`
        SELECT * FROM mail_attachment_assets
        WHERE id=? AND mailbox_id=? AND source=? AND state='ready'
      `).get(id, mailboxId, source);
      if (!row) fail(404, 'ASSET_NOT_FOUND');
      total += Number(row.byte_length);
      if (total > ATTACHMENT_LIMITS.maxFileBytes) fail(413, 'ATTACHMENT_TOO_LARGE');
      assets.push({
        ordinal,
        id: row.id,
        name: row.display_name,
        mime: row.mime_type,
        size: Number(row.byte_length),
        sha256: row.sha256,
        origin: row.origin,
        drive_version: row.drive_version ?? null,
        export_mime: row.export_mime ?? null,
      });
    });
    return assets;
  }

  assertFrozenAssets(draftId) {
    for (const row of this.attachmentRows(draftId)) {
      if (row.state !== 'ready'
        || row.sha256 !== row.frozen_sha256
        || row.display_name !== row.frozen_name
        || row.mime_type !== row.frozen_mime
        || Number(row.byte_length) !== Number(row.frozen_size)
        || row.scan_policy_version !== SCAN_POLICY_VERSION) {
        fail(409, 'ASSET_CHANGED');
      }
    }
  }

  create(mailboxId, source, input) {
    const principals = { ui: 'human:ui', 'grok-bot': 'agent:grok-bot', jarvis: 'agent:jarvis' };
    const ownerPrincipal = principals[source];
    if (!ownerPrincipal) fail(400, 'INVALID_DRAFT_SOURCE');
    const keys = new Set(['request_id', 'to', 'cc', 'subject', 'body_text', 'message_id', 'attachment_ids', 'drive_links']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.has(key))) {
      fail(400, 'INVALID_DRAFT_FIELDS');
    }
    if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.request_id)) {
      fail(400, 'INVALID_REQUEST_ID');
    }
    const ids = attachmentIds(input.attachment_ids);
    const links = digestDriveLinks(normalizeDriveLinks(input.drive_links));
    const userBody = text(input.body_text, 30000);
    const appendix = renderDriveLinks(links);
    if (userBody.length + appendix.length > 30000) fail(400, 'INVALID_DRAFT_TEXT');
    const payload = {
      to: addresses(input.to), cc: addresses(input.cc),
      subject: text(input.subject, 998, true), body_text: userBody + appendix,
      message_id: input.message_id ?? null,
    };
    if (payload.message_id !== null && (!Number.isSafeInteger(payload.message_id) || payload.message_id < 1)) fail(400, 'INVALID_SOURCE_MESSAGE');
    this.assertRecipientsAllowed(payload);
    return this.transaction(() => {
      if (payload.message_id !== null && !this.db.prepare('SELECT id FROM messages WHERE id=? AND mailbox_id=? AND deleted_at IS NULL').get(payload.message_id, mailboxId)) {
        fail(404, 'SOURCE_MESSAGE_NOT_FOUND');
      }
      const attachments = this.loadBoundAssets(mailboxId, source, ids);
      const canonical = canonicalSendPayload({ ...payload, attachments, links });
      const digest = digestCanonical(canonical.body);
      const previous = this.db.prepare('SELECT draft_id,payload_digest FROM mail_send_drafts WHERE mailbox_id=? AND source=? AND request_id=?')
        .get(mailboxId, source, input.request_id);
      if (previous) {
        if (previous.payload_digest !== digest) fail(409, 'IDEMPOTENCY_CONFLICT');
        return { draft: this.get(mailboxId, previous.draft_id), replay: true };
      }
      const id = randomUUID();
      const status = payload.to.length && payload.subject && userBody ? 'needs_approval' : 'needs_clarification';
      this.db.prepare(`INSERT INTO mail_send_drafts
        (draft_id,mailbox_id,request_id,source,owner_principal,message_id,to_json,cc_json,subject,body_text,payload_digest,status,created_at,digest_version,links_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, mailboxId, input.request_id, source, ownerPrincipal, payload.message_id,
        JSON.stringify(payload.to), JSON.stringify(payload.cc), payload.subject, payload.body_text, digest, status, this.now(),
        canonical.version, JSON.stringify(links),
      );
      const insertAttachment = this.db.prepare(`
        INSERT INTO mail_draft_attachments(draft_id,ordinal,asset_id,frozen_name,frozen_mime,frozen_size,frozen_sha256)
        VALUES (?,?,?,?,?,?,?)
      `);
      for (const item of attachments) {
        insertAttachment.run(id, item.ordinal, item.id, item.name, item.mime, item.size, item.sha256);
      }
      this.event(id, status, source);
      return { draft: this.get(mailboxId, id), replay: false };
    });
  }

  approve(mailboxId, id, { actor, digest, allowSend, hasSendScope }) {
    if (allowSend !== true) fail(403, 'MAIL_SEND_DISABLED');
    if (hasSendScope !== true) fail(403, 'MAIL_SEND_SCOPE_REQUIRED');
    if (typeof actor !== 'string' || !actor.startsWith('session:') || actor.length > 160) fail(403, 'HUMAN_APPROVAL_REQUIRED');
    return this.transaction(() => {
      const draft = this.get(mailboxId, id);
      if (digest !== draft.payload_digest) fail(409, 'DRAFT_DIGEST_MISMATCH');
      this.assertRecipientsAllowed(draft);
      this.assertFrozenAssets(id);
      if (['approved', 'sending', 'sent'].includes(draft.status)) return draft;
      if (draft.status !== 'needs_approval') fail(409, 'DRAFT_NOT_APPROVABLE');
      this.db.prepare('UPDATE mail_send_drafts SET status=?,approved_at=?,approved_by=? WHERE draft_id=?')
        .run('approved', this.now(), actor, id);
      this.event(id, 'approved', actor);
      return this.get(mailboxId, id);
    });
  }

  async verifySendBuffers(mailboxId, id, { getKey }) {
    const draft = this.get(mailboxId, id);
    const rows = this.attachmentRows(id);
    this.assertFrozenAssets(id);
    if (!rows.length) return [];
    const key = await getKey();
    if (!Buffer.isBuffer(key) || key.length !== 32) fail(503, 'ATTACHMENTS_DISABLED');
    const buffers = [];
    for (const row of rows) {
      const bytes = decryptAttachment({
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        key,
        assetId: row.asset_id,
        mailboxId: row.mailbox_id,
        encryptionAadVersion: row.encryption_aad_version,
        encryptionPolicyVersion: row.encryption_policy_version,
      });
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== row.frozen_sha256 || bytes.length !== Number(row.frozen_size)) fail(409, 'ASSET_CHANGED');
      buffers.push({
        id: row.asset_id,
        name: row.frozen_name,
        mime: row.frozen_mime,
        size: bytes.length,
        sha256: digest,
        origin: row.origin,
        drive_version: row.drive_version ?? null,
        export_mime: row.export_mime ?? null,
        bytes,
      });
    }
    const estimated = Buffer.byteLength(JSON.stringify({
      subject: draft.subject,
      body_text: draft.body_text,
      to: draft.to,
      cc: draft.cc,
    }), 'utf8') + buffers.reduce((sum, item) => sum + Math.ceil(item.bytes.length * 4 / 3) + 256, 0);
    if (estimated > GRAPH_SERIALIZED_LIMIT) fail(413, 'ATTACHMENT_TOO_LARGE');
    return buffers;
  }

  claim(mailboxId, id) {
    return this.transaction(() => {
      const draft = this.get(mailboxId, id);
      if (draft.status !== 'approved') return false;
      this.assertFrozenAssets(id);
      const changed = this.db.prepare('UPDATE mail_send_drafts SET status=? WHERE draft_id=? AND status=?').run('sending', id, 'approved');
      if (changed.changes !== 1) return false;
      this.event(id, 'sending', 'mail-intelligence');
      this.enqueueReconciliation(this.get(mailboxId, id));
      return true;
    });
  }

  cancel(mailboxId, id, actor) {
    if (typeof actor !== 'string' || !actor.startsWith('session:') || actor.length > 160) fail(403, 'HUMAN_APPROVAL_REQUIRED');
    return this.transaction(() => {
      const draft = this.get(mailboxId, id);
      if (draft.status === 'cancelled') return draft;
      if (!['needs_approval', 'needs_clarification', 'approved'].includes(draft.status)) fail(409, 'DRAFT_NOT_CANCELLABLE');
      this.db.prepare('UPDATE mail_send_drafts SET status=? WHERE draft_id=?').run('cancelled', id);
      this.event(id, 'cancelled', actor);
      return this.get(mailboxId, id);
    });
  }

  recordOutcome(mailboxId, id, { graphMessageId = '', sentAt = '', failureCode = '', uncertain = false }) {
    return this.transaction(() => {
      const draft = this.get(mailboxId, id);
      if (draft.status === 'sent') {
        this.enqueueCompanyMemoryReceipt(draft);
        return draft;
      }
      if (draft.status !== 'sending') fail(409, 'DRAFT_NOT_SENDING');
      if (graphMessageId && sentAt) {
        if (typeof graphMessageId !== 'string' || graphMessageId.length > 2048 || !Number.isFinite(Date.parse(sentAt))) fail(400, 'INVALID_RECEIPT');
        this.db.prepare('UPDATE mail_send_drafts SET status=?,graph_message_id=?,sent_at=?,failure_reason=NULL WHERE draft_id=?')
          .run('sent', graphMessageId, sentAt, id);
        this.event(id, 'sent', 'mail-intelligence');
        if (this.hasReconciliationQueue()) this.db.prepare('UPDATE mail_send_reconciliation_jobs SET state=\'complete\', lease_owner=\'\', lease_expires_at=NULL, updated_at=? WHERE draft_id=?').run(this.now(), id);
        const sent = this.get(mailboxId, id);
        this.enqueueCompanyMemoryReceipt(sent);
        return sent;
      }
      if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(failureCode)) fail(400, 'INVALID_FAILURE_CODE');
      const status = uncertain ? 'sending' : 'failed';
      this.db.prepare('UPDATE mail_send_drafts SET status=?,failure_reason=? WHERE draft_id=?').run(status, failureCode, id);
      this.event(id, status, 'mail-intelligence', failureCode);
      if (uncertain) this.enqueueReconciliation(this.get(mailboxId, id), { failureCode });
      return this.get(mailboxId, id);
    });
  }

  enqueueCompanyMemoryReceipt(draft) {
    const workspaceId = this.companyMemory?.workspaceId;
    if (!workspaceId) return;
    enqueueSentDraftCompanyMemoryOutbox(this.db, {
      workspaceId,
      provider: this.companyMemory.provider || 'outlook',
      draft,
    }, this.now());
  }
}
