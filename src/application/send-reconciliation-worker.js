import { randomUUID } from 'node:crypto';
import { MailSendDrafts } from './mail-send-drafts.js';

function failureCode(error) {
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(String(error?.failureCode || error?.code || ''))
    ? String(error.failureCode || error.code)
    : 'GRAPH_RECEIPT_UNAVAILABLE';
}

function iso(value) {
  return new Date(value).toISOString();
}

/**
 * Durable, read-only reconciliation for drafts left in `sending`.
 * This worker deliberately has no send method: a lost Graph acknowledgement
 * is resolved by searching Sent Items, never by issuing another sendMail.
 */
export class SendReconciliationWorker {
  constructor({
    db,
    drafts = new MailSendDrafts(db),
    clientFactory,
    getAccessToken,
    now = () => new Date(),
    workerId = `mail-reconcile:${randomUUID()}`,
    leaseMs = 30_000,
    baseBackoffMs = 5_000,
    maxBackoffMs = 15 * 60_000,
  }) {
    if (!db) throw new Error('db is required.');
    if (typeof clientFactory !== 'function') throw new Error('clientFactory is required.');
    if (typeof getAccessToken !== 'function') throw new Error('getAccessToken is required.');
    this.db = db;
    this.drafts = drafts;
    this.clientFactory = clientFactory;
    this.getAccessToken = getAccessToken;
    this.now = now;
    this.workerId = String(workerId);
    this.leaseMs = Math.max(1_000, Number(leaseMs) || 30_000);
    this.baseBackoffMs = Math.max(100, Number(baseBackoffMs) || 5_000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, Number(maxBackoffMs) || 900_000);
  }

  hasQueue() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_send_reconciliation_jobs'").get());
  }

  enqueue(draft, { nextAttemptAt = this.now(), failureCode = '' } = {}) {
    if (!this.hasQueue()) return false;
    const now = iso(this.now());
    this.db.prepare(`
      INSERT INTO mail_send_reconciliation_jobs
        (draft_id, mailbox_id, state, next_attempt_at, last_failure_code, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(draft_id) DO UPDATE SET
        mailbox_id=excluded.mailbox_id,
        state=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.state ELSE 'pending' END,
        next_attempt_at=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.next_attempt_at ELSE excluded.next_attempt_at END,
        last_failure_code=CASE WHEN excluded.last_failure_code <> '' THEN excluded.last_failure_code ELSE mail_send_reconciliation_jobs.last_failure_code END,
        lease_owner=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.lease_owner ELSE '' END,
        lease_expires_at=CASE WHEN mail_send_reconciliation_jobs.state IN ('complete', 'leased') THEN mail_send_reconciliation_jobs.lease_expires_at ELSE NULL END,
        updated_at=excluded.updated_at
    `).run(draft.draft_id, draft.mailbox_id, iso(nextAttemptAt), String(failureCode), now, now);
    return true;
  }

  claimDue(limit = 20) {
    if (!this.hasQueue()) return [];
    const now = this.now();
    const nowIso = iso(now);
    const leaseUntil = iso(new Date(now.getTime() + this.leaseMs));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this._claimDue(limit, nowIso, leaseUntil);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  _claimDue(limit, nowIso, leaseUntil) {
    const rows = this.db.prepare(`
      SELECT j.*, d.status AS draft_status
      FROM mail_send_reconciliation_jobs j
      JOIN mail_send_drafts d ON d.draft_id=j.draft_id
      WHERE d.status='sending'
        AND ((j.state='pending' AND j.next_attempt_at <= ?) OR (j.state='leased' AND j.lease_expires_at <= ?))
      ORDER BY j.next_attempt_at, j.created_at
      LIMIT ?
    `).all(nowIso, nowIso, Math.max(1, Math.min(Number(limit) || 20, 100)));
    const claim = this.db.prepare(`
      UPDATE mail_send_reconciliation_jobs
      SET state='leased', lease_owner=?, lease_expires_at=?, attempt_count=attempt_count+1, updated_at=?
      WHERE draft_id=? AND (state='pending' OR (state='leased' AND lease_expires_at <= ?))
    `);
    return rows.filter((row) => claim.run(this.workerId, leaseUntil, nowIso, row.draft_id, nowIso).changes === 1);
  }

  finish(job, outcome) {
    const now = this.now();
    if (outcome?.graphMessageId && outcome?.sentAt) {
      this.drafts.recordOutcome(job.mailbox_id, job.draft_id, outcome);
      this.db.prepare(`UPDATE mail_send_reconciliation_jobs SET state='complete', lease_owner='', lease_expires_at=NULL, updated_at=? WHERE draft_id=? AND lease_owner=?`)
        .run(iso(now), job.draft_id, this.workerId);
      return { status: 'sent', draftId: job.draft_id };
    }
    const code = failureCode(outcome);
    const attempt = Number(job.attempt_count) || 1;
    const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** Math.min(attempt - 1, 10)));
    this.drafts.recordOutcome(job.mailbox_id, job.draft_id, { uncertain: true, failureCode: code });
    this.db.prepare(`UPDATE mail_send_reconciliation_jobs SET state='pending', lease_owner='', lease_expires_at=NULL, next_attempt_at=?, last_failure_code=?, updated_at=? WHERE draft_id=? AND lease_owner=?`)
      .run(iso(new Date(now.getTime() + delay)), code, iso(now), job.draft_id, this.workerId);
    return { status: 'pending', draftId: job.draft_id, failureCode: code, nextAttemptAt: iso(new Date(now.getTime() + delay)) };
  }

  async runOnce({ limit = 20 } = {}) {
    const jobs = this.claimDue(limit);
    const results = [];
    for (const job of jobs) {
      let outcome;
      try {
        const accessToken = await this.getAccessToken(job.mailbox_id, job.draft_id);
        const mailbox = this.db.prepare('SELECT graph_user FROM mailboxes WHERE id=?').get(job.mailbox_id);
        const draft = this.drafts.get(job.mailbox_id, job.draft_id);
        const client = this.clientFactory({ accessToken, mailboxUser: mailbox?.graph_user || '' });
        if (typeof client?.reconcile !== 'function') throw new Error('READ_RECONCILIATION_REQUIRED');
        outcome = await client.reconcile(draft);
      } catch (error) {
        outcome = { uncertain: true, failureCode: failureCode(error) };
      }
      results.push(this.finish(job, outcome));
    }
    return { claimed: jobs.length, results };
  }
}

export function createSendReconciliationWorker(options) {
  return new SendReconciliationWorker(options);
}
