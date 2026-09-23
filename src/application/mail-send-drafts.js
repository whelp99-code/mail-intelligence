import { createHash, randomUUID } from 'node:crypto';
import {
  assertMailSendRecipientsAllowed,
  normalizeMailSendRecipientAllowlist,
} from '../security/mail-send-recipient-policy.js';

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

export class MailSendDrafts {
  constructor(db, { now = () => new Date().toISOString(), recipientAllowlist = null } = {}) {
    this.db = db;
    this.now = now;
    this.recipientAllowlist = normalizeMailSendRecipientAllowlist(recipientAllowlist);
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
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_send_reconciliation_jobs'").get());
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

  get(mailboxId, id) {
    const row = this.db.prepare('SELECT * FROM mail_send_drafts WHERE mailbox_id=? AND draft_id=?').get(mailboxId, id);
    if (!row) fail(404, 'DRAFT_NOT_FOUND');
    const { to_json: toJson, cc_json: ccJson, ...result } = row;
    return { ...result, to: JSON.parse(toJson), cc: JSON.parse(ccJson) };
  }

  list(mailboxId) {
    return this.db.prepare('SELECT draft_id FROM mail_send_drafts WHERE mailbox_id=? ORDER BY created_at DESC LIMIT 100')
      .all(mailboxId).map((row) => this.get(mailboxId, row.draft_id));
  }

  create(mailboxId, source, input) {
    const principals = { ui: 'human:ui', 'grok-bot': 'agent:grok-bot', jarvis: 'agent:jarvis' };
    const ownerPrincipal = principals[source];
    if (!ownerPrincipal) fail(400, 'INVALID_DRAFT_SOURCE');
    const keys = new Set(['request_id', 'to', 'cc', 'subject', 'body_text', 'message_id']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.has(key))) {
      fail(400, 'INVALID_DRAFT_FIELDS');
    }
    if (typeof input.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.request_id)) {
      fail(400, 'INVALID_REQUEST_ID');
    }
    const payload = {
      to: addresses(input.to), cc: addresses(input.cc),
      subject: text(input.subject, 998, true), body_text: text(input.body_text, 30000),
      message_id: input.message_id ?? null,
    };
    if (payload.message_id !== null && (!Number.isSafeInteger(payload.message_id) || payload.message_id < 1)) fail(400, 'INVALID_SOURCE_MESSAGE');
    this.assertRecipientsAllowed(payload);
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.transaction(() => {
      if (payload.message_id !== null && !this.db.prepare('SELECT id FROM messages WHERE id=? AND mailbox_id=? AND deleted_at IS NULL').get(payload.message_id, mailboxId)) {
        fail(404, 'SOURCE_MESSAGE_NOT_FOUND');
      }
      const previous = this.db.prepare('SELECT draft_id,payload_digest FROM mail_send_drafts WHERE mailbox_id=? AND source=? AND request_id=?')
        .get(mailboxId, source, input.request_id);
      if (previous) {
        if (previous.payload_digest !== digest) fail(409, 'IDEMPOTENCY_CONFLICT');
        return { draft: this.get(mailboxId, previous.draft_id), replay: true };
      }
      const id = randomUUID();
      const status = payload.to.length && payload.subject && payload.body_text ? 'needs_approval' : 'needs_clarification';
      this.db.prepare(`INSERT INTO mail_send_drafts
        (draft_id,mailbox_id,request_id,source,owner_principal,message_id,to_json,cc_json,subject,body_text,payload_digest,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, mailboxId, input.request_id, source, ownerPrincipal, payload.message_id,
        JSON.stringify(payload.to), JSON.stringify(payload.cc), payload.subject, payload.body_text, digest, status, this.now());
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
      if (['approved', 'sending', 'sent'].includes(draft.status)) return draft;
      if (draft.status !== 'needs_approval') fail(409, 'DRAFT_NOT_APPROVABLE');
      this.db.prepare('UPDATE mail_send_drafts SET status=?,approved_at=?,approved_by=? WHERE draft_id=?')
        .run('approved', this.now(), actor, id);
      this.event(id, 'approved', actor);
      return this.get(mailboxId, id);
    });
  }

  claim(mailboxId, id) {
    return this.transaction(() => {
      const draft = this.get(mailboxId, id);
      if (draft.status !== 'approved') return false;
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
      if (draft.status === 'sent') return draft;
      if (draft.status !== 'sending') fail(409, 'DRAFT_NOT_SENDING');
      if (graphMessageId && sentAt) {
        if (typeof graphMessageId !== 'string' || graphMessageId.length > 2048 || !Number.isFinite(Date.parse(sentAt))) fail(400, 'INVALID_RECEIPT');
        this.db.prepare('UPDATE mail_send_drafts SET status=?,graph_message_id=?,sent_at=?,failure_reason=NULL WHERE draft_id=?')
          .run('sent', graphMessageId, sentAt, id);
        this.event(id, 'sent', 'mail-intelligence');
        if (this.hasReconciliationQueue()) this.db.prepare("UPDATE mail_send_reconciliation_jobs SET state='complete', lease_owner='', lease_expires_at=NULL, updated_at=? WHERE draft_id=?").run(this.now(), id);
      } else {
        if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(failureCode)) fail(400, 'INVALID_FAILURE_CODE');
        const status = uncertain ? 'sending' : 'failed';
        this.db.prepare('UPDATE mail_send_drafts SET status=?,failure_reason=? WHERE draft_id=?').run(status, failureCode, id);
        this.event(id, status, 'mail-intelligence', failureCode);
        if (uncertain) this.enqueueReconciliation(this.get(mailboxId, id), { failureCode });
      }
      return this.get(mailboxId, id);
    });
  }
}
