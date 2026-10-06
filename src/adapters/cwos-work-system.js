/**
 * CWOS v2 boundary. It emits candidate links and reads provider data; it never
 * writes CRM/Notion state. Notion is intentionally a read-only projection.
 */
export class CwosWorkSystemAdapter {
  constructor({ db, now = () => new Date().toISOString(), cwosClient = null, notionReader = null, commandClient = null } = {}) {
    if (!db) throw new Error('db is required.');
    this.db = db;
    this.now = now;
    this.cwosClient = cwosClient;
    this.notionReader = notionReader;
    this.commandClient = commandClient;
  }

  async readMasters({ workspaceId = '', cursor = '' } = {}) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      throw Object.assign(new Error('A verified workspace is required'), { code: 'CWOS_WORKSPACE_REQUIRED' });
    }
    const reader = this.cwosClient ?? this.notionReader;
    if (typeof reader?.readMasters === 'function') {
      const result = await reader.readMasters({ workspaceId, cursor });
      if (!result || !Array.isArray(result.items) || typeof result.workspaceId !== 'string') {
        throw Object.assign(new Error('Invalid work-system response'), { code: 'CWOS_RESPONSE_INVALID' });
      }
      if (result.workspaceId !== workspaceId) {
        throw Object.assign(new Error('Work-system response has a different workspace'), { code: 'CWOS_RESPONSE_SCOPE_MISMATCH' });
      }
      return result;
    }
    throw Object.assign(new Error('No work-system reader is connected'), { code: 'CWOS_CLIENT_UNAVAILABLE' });
  }

  candidate({ mailboxId, messageId, graphId, objectType, externalId, name = '', confidence = 0, evidence = [] }) {
    if (!['account', 'engagement', 'activity', 'commitment'].includes(objectType)) throw new Error('INVALID_WORK_OBJECT');
    const score = Math.max(0, Math.min(1, Number(confidence) || 0));
    const now = this.now();
    const previous = this.db.prepare(`SELECT evidence_json FROM mail_work_links
      WHERE mailbox_id=? AND message_id=? AND system='cwos' AND object_type=? AND external_id=?`)
      .get(mailboxId, messageId, objectType, String(externalId));
    const previousEvidence = JSON.parse(previous?.evidence_json || '[]');
    const revisions = previousEvidence.filter((item) => item.kind === 'mail_source_revision');
    const priorSource = previousEvidence.find((item) => item.kind === 'mail_source');
    const source = evidence.find((item) => item.kind === 'mail_source');
    if (priorSource && source) {
      const fingerprint = (item) => JSON.stringify({ ...item, kind: 'mail_source', observedAt: null });
      if (fingerprint(priorSource) !== fingerprint(source)
        && !revisions.some((item) => fingerprint(item) === fingerprint(priorSource))) {
        revisions.push({ ...priorSource, kind: 'mail_source_revision' });
      }
    }
    this.db.prepare(`INSERT INTO mail_work_links
      (mailbox_id,message_id,system,object_type,external_id,name,confidence,evidence_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'candidate',?,?)
      ON CONFLICT(mailbox_id,message_id,system,object_type,external_id) DO UPDATE SET name=excluded.name,confidence=excluded.confidence,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at
      WHERE mail_work_links.status='candidate' AND mail_work_links.corrected_by IS NULL`)
      .run(mailboxId, messageId, 'cwos', objectType, String(externalId), String(name), score, JSON.stringify([{ kind: 'graph_id', value: String(graphId || '') }, ...evidence, ...revisions]), now, now);
    return this.db.prepare('SELECT * FROM mail_work_links WHERE mailbox_id=? AND message_id=? AND system=\'cwos\' AND object_type=? AND external_id=?').get(mailboxId, messageId, objectType, String(externalId));
  }

  listCandidates({ mailboxId, messageId }) {
    return this.db.prepare(`SELECT * FROM mail_work_links
      WHERE mailbox_id=? AND message_id=? AND system='cwos' AND status!='rejected'
      ORDER BY id`).all(mailboxId, messageId).map((row) => ({
      ...row,
      evidence: JSON.parse(row.evidence_json),
    }));
  }

  async write() {
    const error = new Error('CWOS_WRITE_DISABLED');
    error.code = 'CWOS_WRITE_DISABLED';
    throw error;
  }

  async receiveMail(input) {
    if (!this.commandClient) throw Object.assign(new Error('CWOS_CLIENT_UNAVAILABLE'), { code: 'CWOS_CLIENT_UNAVAILABLE' });
    return this.commandClient.receive(input);
  }

  async mapMailWork(input) {
    if (!this.commandClient) throw Object.assign(new Error('CWOS_CLIENT_UNAVAILABLE'), { code: 'CWOS_CLIENT_UNAVAILABLE' });
    return this.commandClient.mapWork(input);
  }

  createMailProductDonorPort() {
    const error = new Error('Mail company-memory donor is not bound on CwosWorkSystemAdapter; CRM must use the Mail outbox port with a Mail database');
    error.code = 'MAIL_ADAPTER_NOT_IMPLEMENTED';
    throw error;
  }
}
