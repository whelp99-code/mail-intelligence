/**
 * CWOS v2 boundary. It emits candidate links and reads provider data; it never
 * writes CRM/Notion state. Notion is intentionally a read-only projection.
 */
export class CwosWorkSystemAdapter {
  constructor({ db, now = () => new Date().toISOString(), cwosClient = null, notionReader = null } = {}) {
    if (!db) throw new Error('db is required.');
    this.db = db;
    this.now = now;
    this.cwosClient = cwosClient;
    this.notionReader = notionReader;
  }

  async readMasters({ workspaceId = '', cursor = '' } = {}) {
    if (this.cwosClient?.readMasters) return this.cwosClient.readMasters({ workspaceId, cursor });
    if (this.notionReader?.readMasters) return this.notionReader.readMasters({ workspaceId, cursor });
    return { system: 'cwos', workspaceId, cursor, items: [] };
  }

  candidate({ mailboxId, messageId, graphId, objectType, externalId, name = '', confidence = 0, evidence = [] }) {
    if (!['account', 'engagement', 'activity', 'commitment'].includes(objectType)) throw new Error('INVALID_WORK_OBJECT');
    const score = Math.max(0, Math.min(1, Number(confidence) || 0));
    const now = this.now();
    this.db.prepare(`INSERT INTO mail_work_links
      (mailbox_id,message_id,system,object_type,external_id,name,confidence,evidence_json,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'candidate',?,?)
      ON CONFLICT(mailbox_id,message_id,system,object_type,external_id) DO UPDATE SET name=excluded.name,confidence=excluded.confidence,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
      .run(mailboxId, messageId, 'cwos', objectType, String(externalId), String(name), score, JSON.stringify([{ kind: 'graph_id', value: String(graphId || '') }, ...evidence]), now, now);
    return this.db.prepare('SELECT * FROM mail_work_links WHERE mailbox_id=? AND message_id=? AND system=\'cwos\' AND object_type=? AND external_id=?').get(mailboxId, messageId, objectType, String(externalId));
  }

  async write() {
    const error = new Error('CWOS_WRITE_DISABLED');
    error.code = 'CWOS_WRITE_DISABLED';
    throw error;
  }
}
