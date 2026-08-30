import { createHash } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STATUS_VALUES = new Set(['urgent', 'active', 'waiting', 'done', 'reference']);
const FEEDBACK_VALUES = new Set(['urgent', 'active', 'waiting', 'done', 'reference']);
const PRECISION_WORK_STATES = new Set([
  'action_required', 'waiting', 'decision_required',
  'completed', 'reference', 'review_required',
]);
const PRECISION_NEXT_ACTORS = new Set([
  'me', 'internal_team', 'external_party', 'shared', 'none', 'unknown',
]);
const PRECISION_PRIORITIES = new Set(['critical', 'high', 'normal', 'low']);
const PRECISION_PROJECT_RESOLUTIONS = new Set(['confirmed', 'candidate', 'unassigned', 'review_required']);
const PRECISION_DUE = new Set(['exact', 'date', 'relative', 'ambiguous', 'none']);

function isoNow() {
  return new Date().toISOString();
}

function jsonText(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function number(value) {
  return Number(value ?? 0);
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeSubject(value = '') {
  return String(value || '')
    .replace(/^(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function boundedLimit(value, fallback = 25, max = 500) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, '\'\'')}'`;
}

function migrationVersion(name) {
  const match = String(name).match(/^(\d+)_.*\.sql$/);
  return match ? Number(match[1]) : null;
}

function ensurePrivateDirectorySync(directoryPath) {
  if (!existsSync(directoryPath)) {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    chmodSync(directoryPath, 0o700);
    return;
  }
  const metadata = statSync(directoryPath);
  if (!metadata.isDirectory()) throw new Error(`Storage path is not a directory: ${directoryPath}`);
  const mode = metadata.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Storage directory must be owner-only (0700): ${directoryPath}`);
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function rowToMessage(row, recipients = []) {
  const grouped = { to: [], cc: [], bcc: [], replyTo: [] };
  for (const recipient of recipients) {
    grouped[recipient.recipient_type]?.push({
      emailAddress: {
        address: recipient.email,
        name: recipient.display_name || '',
      },
    });
  }
  return {
    id: row.graph_id,
    databaseId: number(row.id),
    changeKey: row.change_key || '',
    conversationId: row.conversation_id || '',
    internetMessageId: row.internet_message_id || '',
    subject: row.subject || '(제목 없음)',
    from: row.sender_email || 'unknown',
    fromName: row.sender_name || '',
    toRecipients: grouped.to,
    ccRecipients: grouped.cc,
    bccRecipients: grouped.bcc,
    replyTo: grouped.replyTo,
    cc: grouped.cc.map((item) => item.emailAddress.address),
    receivedAt: row.received_at || '',
    sentAt: row.sent_at || '',
    importance: row.importance || 'normal',
    inferenceClassification: row.inference_classification || '',
    flagStatus: row.flag_status || '',
    categories: parseJson(row.categories_json, []),
    isRead: Boolean(row.is_read),
    isDraft: Boolean(row.is_draft),
    hasAttachments: Boolean(row.has_attachments),
    isPromotional: Boolean(row.is_promotional),
    bodyPreview: row.body_preview || '',
    body: row.body_text || row.body_preview || '',
    webLink: row.web_link || '',
    parentFolderId: row.parent_folder_graph_id || '',
    deletedAt: row.deleted_at || null,
    removedReason: row.removed_reason || '',
  };
}

function normalizeProjectKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeProjectName(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function projectRow(row) {
  if (!row) return null;
  return {
    id: number(row.id),
    mailboxId: number(row.mailbox_id),
    projectKey: row.project_key,
    name: row.name,
    normalizedName: row.normalized_name,
    aliases: parseJson(row.aliases_json, []),
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function precisionRow(row) {
  if (!row) return null;
  return {
    messageId: row.graph_id || '',
    databaseMessageId: number(row.message_id),
    workState: row.work_state,
    nextActor: row.next_actor,
    priority: row.priority,
    dueText: row.due_text || '',
    dueAt: row.due_at || null,
    duePrecision: row.due_precision,
    primaryProjectId: row.primary_project_id == null ? null : number(row.primary_project_id),
    projectName: row.project_name || '',
    projectKey: row.project_key || '',
    projectResolution: row.project_resolution,
    projectCandidate: parseJson(row.project_candidate_json, null),
    signals: parseJson(row.signals_json, []),
    evidence: parseJson(row.evidence_json, {}),
    confidence: parseJson(row.confidence_json, {}),
    reviewReasons: parseJson(row.review_reasons_json, []),
    source: row.source,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    reviewStatus: row.review_status,
    fingerprint: row.fingerprint,
    analyzedAt: row.analyzed_at,
    correctedAt: row.corrected_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteMailStore {
  constructor({
    databasePath,
    migrationsDir = resolve('migrations'),
    now = isoNow,
  }) {
    if (!databasePath || !isAbsolute(databasePath)) {
      throw new Error('databasePath must be an absolute path.');
    }
    this.databasePath = resolve(databasePath);
    this.migrationsDir = resolve(migrationsDir);
    this.now = now;
    this.closed = false;
    const databaseDirectory = dirname(this.databasePath);
    ensurePrivateDirectorySync(databaseDirectory);
    this.db = new DatabaseSync(this.databasePath);
    this.configure();
    this.migrate();
    this.protectDatabaseFiles();
  }

  protectDatabaseFiles() {
    for (const candidate of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(candidate)) continue;
      chmodSync(candidate, 0o600);
    }
  }

  configure() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const files = readdirSync(this.migrationsDir)
      .filter((name) => migrationVersion(name) !== null)
      .sort((a, b) => migrationVersion(a) - migrationVersion(b));
    const getApplied = this.db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version = ?');
    const insertApplied = this.db.prepare(
      'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
    );

    for (const name of files) {
      const version = migrationVersion(name);
      const source = readFileSync(join(this.migrationsDir, name), 'utf8');
      const checksum = digest(source);
      const applied = getApplied.get(version);
      if (applied) {
        if (applied.name !== name || applied.checksum !== checksum) {
          throw new Error(`Migration ${version} checksum or name changed after application.`);
        }
        continue;
      }
      this.transaction(() => {
        this.db.exec(source);
        insertApplied.run(version, name, checksum, this.now());
      });
    }
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.db.exec('COMMIT;');
      this.protectDatabaseFiles();
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      this.protectDatabaseFiles();
      throw error;
    }
  }

  ensureMailbox({ key, address = '', graphUser = '', displayName = '' }) {
    const mailboxKey = String(key || 'me').trim().toLowerCase();
    if (!mailboxKey) throw new Error('mailbox key is required.');
    const now = this.now();
    return this.db.prepare(`
      INSERT INTO mailboxes(mailbox_key, address, graph_user, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_key) DO UPDATE SET
        address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE mailboxes.address END,
        graph_user = CASE WHEN excluded.graph_user <> '' THEN excluded.graph_user ELSE mailboxes.graph_user END,
        display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE mailboxes.display_name END,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(mailboxKey, String(address), String(graphUser), String(displayName), now, now);
  }

  getMailbox(key) {
    return this.db.prepare('SELECT * FROM mailboxes WHERE mailbox_key = ?').get(String(key || '').toLowerCase()) || null;
  }

  ensureFolder({ mailboxId, graphId, wellKnownName = '', displayName = '', parentGraphId = '' }) {
    if (!mailboxId || !graphId) throw new Error('mailboxId and graphId are required.');
    const now = this.now();
    return this.db.prepare(`
      INSERT INTO mail_folders(
        mailbox_id, graph_id, well_known_name, display_name, parent_graph_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_id, graph_id) DO UPDATE SET
        well_known_name = CASE WHEN excluded.well_known_name <> '' THEN excluded.well_known_name ELSE mail_folders.well_known_name END,
        display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE mail_folders.display_name END,
        parent_graph_id = CASE WHEN excluded.parent_graph_id <> '' THEN excluded.parent_graph_id ELSE mail_folders.parent_graph_id END,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      mailboxId,
      String(graphId),
      String(wellKnownName),
      String(displayName),
      String(parentGraphId),
      now,
      now,
    );
  }

  getFolder({ mailboxId, graphId, wellKnownName }) {
    if (graphId) {
      return this.db.prepare('SELECT * FROM mail_folders WHERE mailbox_id = ? AND graph_id = ?')
        .get(mailboxId, graphId) || null;
    }
    return this.db.prepare('SELECT * FROM mail_folders WHERE mailbox_id = ? AND well_known_name = ?')
      .get(mailboxId, wellKnownName || '') || null;
  }

  clearFolderCursor(folderId, { errorCode = '', errorMessage = '' } = {}) {
    this.db.prepare(`
      UPDATE mail_folders SET
        delta_link = '', next_link = '', sync_state = 'idle',
        last_error_code = ?, last_error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(errorCode, errorMessage, this.now(), folderId);
  }

  startSyncRun({ mailboxId, folderId, runType, cursorStart = '' }) {
    const now = this.now();
    const result = this.db.prepare(`
      INSERT INTO sync_runs(
        mailbox_id, folder_id, run_type, status, cursor_start,
        started_at, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, ?)
    `).run(mailboxId, folderId, runType, String(cursorStart || ''), now, now);
    this.db.prepare(`
      UPDATE mail_folders SET
        sync_state = 'running', last_sync_started_at = ?,
        last_error_code = '', last_error_message = '', updated_at = ?
      WHERE id = ?
    `).run(now, now, folderId);
    return number(result.lastInsertRowid);
  }

  recordSyncFailure(syncRunId, folderId, error, status = 'failed') {
    const now = this.now();
    const code = String(error?.code || 'SYNC_FAILED').slice(0, 120);
    const message = String(error?.message || 'Sync failed.').slice(0, 1000);
    this.transaction(() => {
      this.db.prepare(`
        UPDATE sync_runs SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(status, code, message, now, now, syncRunId);
      this.db.prepare(`
        UPDATE mail_folders SET sync_state = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(status === 'interrupted' ? 'interrupted' : 'failed', code, message, now, folderId);
    });
  }

  completeSyncRun(syncRunId, folderId, cursorEnd = '') {
    const now = this.now();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE sync_runs SET status = 'completed', cursor_end = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(String(cursorEnd || ''), now, now, syncRunId);
      this.db.prepare(`
        UPDATE mail_folders SET
          sync_state = 'idle', last_sync_completed_at = ?,
          last_error_code = '', last_error_message = '', updated_at = ?
        WHERE id = ?
      `).run(now, now, folderId);
    });
  }

  applyDeltaPage({
    mailboxId,
    folderId,
    syncRunId,
    pageIndex,
    requestUrl = '',
    items = [],
    nextLink = '',
    deltaLink = '',
  }) {
    return this.transaction(() => {
      let upserts = 0;
      let deletions = 0;
      const affectedThreads = new Set();
      for (const item of items) {
        if (item.kind === 'removed') {
          const result = this.markMessageRemoved({ mailboxId, folderId, item });
          deletions += result.changed ? 1 : 0;
          if (result.threadId) affectedThreads.add(result.threadId);
        } else {
          const result = this.upsertNormalizedMessage({ mailboxId, folderId, message: item });
          upserts += result.changed ? 1 : 0;
          if (result.threadId) affectedThreads.add(result.threadId);
        }
      }
      for (const threadId of affectedThreads) this.recomputeThread(threadId);

      const now = this.now();
      this.db.prepare(`
        UPDATE mail_folders SET
          next_link = ?,
          delta_link = CASE WHEN ? <> '' THEN ? ELSE delta_link END,
          sync_state = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        String(nextLink || ''),
        String(deltaLink || ''),
        String(deltaLink || ''),
        nextLink ? 'running' : 'idle',
        now,
        folderId,
      );
      this.db.prepare(`
        INSERT INTO sync_pages(
          sync_run_id, page_index, request_url_hash, item_count,
          upsert_count, deletion_count, next_link, delta_link, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        syncRunId,
        pageIndex,
        requestUrl ? digest(requestUrl) : '',
        items.length,
        upserts,
        deletions,
        String(nextLink || ''),
        String(deltaLink || ''),
        now,
      );
      this.db.prepare(`
        UPDATE sync_runs SET
          pages_processed = pages_processed + 1,
          items_received = items_received + ?,
          upserts = upserts + ?, deletions = deletions + ?,
          cursor_end = CASE WHEN ? <> '' THEN ? WHEN ? <> '' THEN ? ELSE cursor_end END,
          updated_at = ?
        WHERE id = ?
      `).run(
        items.length,
        upserts,
        deletions,
        String(deltaLink || ''),
        String(deltaLink || ''),
        String(nextLink || ''),
        String(nextLink || ''),
        now,
        syncRunId,
      );
      return { upserts, deletions, items: items.length };
    });
  }

  upsertNormalizedMessage({ mailboxId, folderId, message }) {
    if (!message?.graphId) throw new Error('Normalized message graphId is required.');
    const previous = this.db.prepare(
      'SELECT id, change_key, graph_modified_at, deleted_at, thread_id, first_seen_at FROM messages WHERE mailbox_id = ? AND graph_id = ?',
    ).get(mailboxId, message.graphId);
    const sender = message.sender?.email ? this.upsertPerson(message.sender) : null;
    const thread = message.conversationId
      ? this.upsertThread(mailboxId, message.conversationId, message.subject, message.receivedAt)
      : null;
    const now = this.now();
    const row = this.db.prepare(`
      INSERT INTO messages(
        mailbox_id, folder_id, thread_id, graph_id, internet_message_id,
        change_key, conversation_id, subject, normalized_subject,
        sender_person_id, sender_email, sender_name, received_at, sent_at,
        graph_created_at, graph_modified_at, importance, inference_classification,
        flag_status, categories_json, is_read, is_draft, has_attachments,
        is_promotional, body_preview, body_text, web_link,
        parent_folder_graph_id, removed_reason, deleted_at, source_json,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, ?, ?
      )
      ON CONFLICT(mailbox_id, graph_id) DO UPDATE SET
        folder_id = excluded.folder_id,
        thread_id = excluded.thread_id,
        internet_message_id = excluded.internet_message_id,
        change_key = excluded.change_key,
        conversation_id = excluded.conversation_id,
        subject = excluded.subject,
        normalized_subject = excluded.normalized_subject,
        sender_person_id = excluded.sender_person_id,
        sender_email = excluded.sender_email,
        sender_name = excluded.sender_name,
        received_at = excluded.received_at,
        sent_at = excluded.sent_at,
        graph_created_at = excluded.graph_created_at,
        graph_modified_at = excluded.graph_modified_at,
        importance = excluded.importance,
        inference_classification = excluded.inference_classification,
        flag_status = excluded.flag_status,
        categories_json = excluded.categories_json,
        is_read = excluded.is_read,
        is_draft = excluded.is_draft,
        has_attachments = excluded.has_attachments,
        is_promotional = excluded.is_promotional,
        body_preview = excluded.body_preview,
        body_text = excluded.body_text,
        web_link = excluded.web_link,
        parent_folder_graph_id = excluded.parent_folder_graph_id,
        removed_reason = '',
        deleted_at = NULL,
        source_json = excluded.source_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      mailboxId,
      folderId,
      thread?.id || null,
      message.graphId,
      message.internetMessageId || '',
      message.changeKey || '',
      message.conversationId || '',
      message.subject || '',
      normalizeSubject(message.subject),
      sender?.id || null,
      message.sender?.email || '',
      message.sender?.name || '',
      message.receivedAt || null,
      message.sentAt || null,
      message.createdAt || null,
      message.modifiedAt || null,
      message.importance || 'normal',
      message.inferenceClassification || '',
      message.flagStatus || '',
      jsonText(message.categories, []),
      message.isRead ? 1 : 0,
      message.isDraft ? 1 : 0,
      message.hasAttachments ? 1 : 0,
      message.isPromotional ? 1 : 0,
      message.bodyPreview || '',
      message.bodyText || '',
      message.webLink || '',
      message.parentFolderId || '',
      jsonText(message.source || {}, {}),
      previous?.first_seen_at || now,
      now,
      now,
    );

    if (!previous?.id && row.first_seen_at === null) {
      this.db.prepare('UPDATE messages SET first_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    this.replaceRecipients(row.id, message.recipients || []);
    if (Array.isArray(message.attachments)) this.replaceAttachments(row.id, message.attachments);

    const changed = !previous
      || previous.change_key !== (message.changeKey || '')
      || previous.graph_modified_at !== (message.modifiedAt || null)
      || previous.deleted_at !== null;
    return { id: number(row.id), threadId: row.thread_id ? number(row.thread_id) : null, changed };
  }

  markMessageRemoved({ mailboxId, folderId, item }) {
    const previous = this.db.prepare(
      'SELECT id, thread_id, deleted_at FROM messages WHERE mailbox_id = ? AND graph_id = ?',
    ).get(mailboxId, item.graphId);
    const now = this.now();
    const row = this.db.prepare(`
      INSERT INTO messages(
        mailbox_id, folder_id, graph_id, removed_reason, deleted_at,
        source_json, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_id, graph_id) DO UPDATE SET
        folder_id = excluded.folder_id,
        removed_reason = excluded.removed_reason,
        deleted_at = COALESCE(messages.deleted_at, excluded.deleted_at),
        source_json = excluded.source_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      RETURNING id, thread_id, deleted_at
    `).get(
      mailboxId,
      folderId,
      item.graphId,
      item.reason || 'changed',
      now,
      jsonText(item.source || {}, {}),
      now,
      now,
      now,
    );
    return {
      id: number(row.id),
      threadId: row.thread_id ? number(row.thread_id) : null,
      changed: !previous || !previous.deleted_at,
    };
  }

  upsertPerson(person) {
    const email = String(person.email || '').trim();
    const emailNorm = normalizeEmail(email);
    if (!emailNorm) return null;
    const now = this.now();
    return this.db.prepare(`
      INSERT INTO persons(email_norm, email, display_name, first_seen_at, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(email_norm) DO UPDATE SET
        email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE persons.email END,
        display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE persons.display_name END,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(emailNorm, email, person.name || '', now, now, now);
  }

  upsertThread(mailboxId, conversationId, subject, receivedAt) {
    const now = this.now();
    return this.db.prepare(`
      INSERT INTO threads(
        mailbox_id, conversation_id, normalized_subject,
        first_received_at, last_received_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mailbox_id, conversation_id) DO UPDATE SET
        normalized_subject = CASE WHEN excluded.normalized_subject <> '' THEN excluded.normalized_subject ELSE threads.normalized_subject END,
        first_received_at = CASE
          WHEN threads.first_received_at IS NULL THEN excluded.first_received_at
          WHEN excluded.first_received_at IS NULL THEN threads.first_received_at
          ELSE MIN(threads.first_received_at, excluded.first_received_at)
        END,
        last_received_at = CASE
          WHEN threads.last_received_at IS NULL THEN excluded.last_received_at
          WHEN excluded.last_received_at IS NULL THEN threads.last_received_at
          ELSE MAX(threads.last_received_at, excluded.last_received_at)
        END,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      mailboxId,
      conversationId,
      normalizeSubject(subject),
      receivedAt || null,
      receivedAt || null,
      now,
      now,
    );
  }

  recomputeThread(threadId) {
    this.db.prepare(`
      UPDATE threads SET
        message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ? AND deleted_at IS NULL),
        first_received_at = (SELECT MIN(received_at) FROM messages WHERE thread_id = ? AND deleted_at IS NULL),
        last_received_at = (SELECT MAX(received_at) FROM messages WHERE thread_id = ? AND deleted_at IS NULL),
        updated_at = ?
      WHERE id = ?
    `).run(threadId, threadId, threadId, this.now(), threadId);
  }

  replaceRecipients(messageId, recipients) {
    this.db.prepare('DELETE FROM message_recipients WHERE message_id = ?').run(messageId);
    const insert = this.db.prepare(`
      INSERT INTO message_recipients(
        message_id, person_id, recipient_type, email_norm, email,
        display_name, ordinal, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    recipients.forEach((recipient, index) => {
      const email = String(recipient.email || '').trim();
      const emailNorm = normalizeEmail(email);
      if (!emailNorm || !['to', 'cc', 'bcc', 'replyTo'].includes(recipient.type)) return;
      const person = this.upsertPerson({ email, name: recipient.name || '' });
      insert.run(
        messageId,
        person?.id || null,
        recipient.type,
        emailNorm,
        email,
        recipient.name || '',
        Number.isInteger(recipient.ordinal) ? recipient.ordinal : index,
        this.now(),
      );
    });
  }

  replaceAttachments(messageId, attachments) {
    this.db.prepare('DELETE FROM attachments WHERE message_id = ?').run(messageId);
    const insert = this.db.prepare(`
      INSERT INTO attachments(
        message_id, graph_id, attachment_type, name, content_type,
        size_bytes, is_inline, content_id, last_modified_at,
        source_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    attachments.forEach((attachment, index) => {
      const graphId = String(attachment.graphId || `metadata-${index}`);
      const now = this.now();
      insert.run(
        messageId,
        graphId,
        attachment.type || '',
        attachment.name || '',
        attachment.contentType || '',
        Math.max(Number(attachment.size || 0), 0),
        attachment.isInline ? 1 : 0,
        attachment.contentId || '',
        attachment.modifiedAt || null,
        jsonText(attachment.source || {}, {}),
        now,
        now,
      );
    });
  }

  getRecentMessages(mailboxId, { limit = 25, includeDeleted = false } = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE mailbox_id = ? AND (? = 1 OR deleted_at IS NULL)
      ORDER BY COALESCE(received_at, sent_at, first_seen_at) DESC, id DESC
      LIMIT ?
    `).all(mailboxId, includeDeleted ? 1 : 0, boundedLimit(limit));
    if (!rows.length) return [];
    const recipientsByMessage = new Map();
    const recipientQuery = this.db.prepare(`
      SELECT * FROM message_recipients WHERE message_id = ? ORDER BY recipient_type, ordinal, id
    `);
    for (const row of rows) recipientsByMessage.set(row.id, recipientQuery.all(row.id));
    return rows.map((row) => rowToMessage(row, recipientsByMessage.get(row.id)));
  }

  countMessages(mailboxId, { includeDeleted = false } = {}) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE mailbox_id = ? AND (? = 1 OR deleted_at IS NULL)
    `).get(mailboxId, includeDeleted ? 1 : 0);
    return number(row?.count);
  }

  getAllMessages(mailboxId, { includeDeleted = false } = {}) {
    return this.getRecentMessages(mailboxId, { limit: 500, includeDeleted });
  }

  getMessagePage(mailboxId, { limit = 250, offset = 0, includeDeleted = false } = {}) {
    const safeOffset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE mailbox_id = ? AND (? = 1 OR deleted_at IS NULL)
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(mailboxId, includeDeleted ? 1 : 0, boundedLimit(limit, 250, 1000), safeOffset);
    if (!rows.length) return [];
    const recipientQuery = this.db.prepare(`
      SELECT * FROM message_recipients WHERE message_id = ? ORDER BY recipient_type, ordinal, id
    `);
    return rows.map((row) => rowToMessage(row, recipientQuery.all(row.id)));
  }

  getMessagesNeedingPrecision(mailboxId, { limit = 250 } = {}) {
    const rows = this.db.prepare(`
      SELECT m.* FROM messages m
      LEFT JOIN precision_classifications pc ON pc.message_id = m.id
      WHERE m.mailbox_id = ?
        AND m.deleted_at IS NULL
        AND (pc.message_id IS NULL OR pc.updated_at < m.updated_at)
      ORDER BY m.id ASC
      LIMIT ?
    `).all(mailboxId, boundedLimit(limit, 250, 1000));
    if (!rows.length) return [];
    const recipientQuery = this.db.prepare(`
      SELECT * FROM message_recipients WHERE message_id = ? ORDER BY recipient_type, ordinal, id
    `);
    return rows.map((row) => rowToMessage(row, recipientQuery.all(row.id)));
  }

  getMessageRecord(mailboxId, graphId) {
    return this.db.prepare('SELECT * FROM messages WHERE mailbox_id = ? AND graph_id = ?')
      .get(mailboxId, graphId) || null;
  }

  getMessage(mailboxId, graphId) {
    const row = this.getMessageRecord(mailboxId, graphId);
    if (!row) return null;
    const recipients = this.db.prepare(`
      SELECT * FROM message_recipients
      WHERE message_id = ? ORDER BY recipient_type, ordinal, id
    `).all(row.id);
    return rowToMessage(row, recipients);
  }

  getAttachments(messageId) {
    return this.db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY id').all(messageId);
  }

  listProjects(mailboxId, { includeArchived = false } = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM projects
      WHERE mailbox_id = ? AND (? = 1 OR status = 'active')
      ORDER BY normalized_name, id
    `).all(mailboxId, includeArchived ? 1 : 0);
    return rows.map(projectRow);
  }

  getProject(mailboxId, projectId) {
    const row = this.db.prepare('SELECT * FROM projects WHERE mailbox_id = ? AND id = ?')
      .get(mailboxId, Number(projectId));
    return projectRow(row);
  }

  createProject(mailboxId, {
    name,
    projectKey = '',
    aliases = [],
    status = 'active',
    createdBy = 'user',
  } = {}) {
    const cleanName = String(name || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
    const normalizedName = normalizeProjectName(cleanName);
    if (normalizedName.length < 2) throw new Error('Project name must contain at least two characters.');
    if (!['active', 'archived'].includes(status)) throw new Error('Invalid project status.');
    if (!['user', 'import'].includes(createdBy)) throw new Error('Invalid project creation source.');
    const cleanAliases = [...new Set((Array.isArray(aliases) ? aliases : [])
      .map((value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200))
      .filter((value) => value.length >= 2 && normalizeProjectName(value) !== normalizedName))]
      .slice(0, 30);
    const proposedTerms = new Set([normalizedName, ...cleanAliases.map(normalizeProjectName)]);
    for (const existing of this.listProjects(mailboxId, { includeArchived: true })) {
      const existingTerms = new Set([
        existing.normalizedName,
        ...existing.aliases.map(normalizeProjectName),
      ]);
      const conflict = [...proposedTerms].find((term) => existingTerms.has(term));
      if (conflict) {
        const error = new Error(`Project name or alias already belongs to ${existing.name}.`);
        error.code = 'PROJECT_ALIAS_CONFLICT';
        throw error;
      }
    }
    const key = normalizeProjectKey(projectKey || cleanName);
    if (!key) throw new Error('Project key is invalid.');
    const now = this.now();
    const result = this.db.prepare(`
      INSERT INTO projects(
        mailbox_id, project_key, name, normalized_name, aliases_json,
        status, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mailboxId,
      key,
      cleanName,
      normalizedName,
      jsonText(cleanAliases, []),
      status,
      createdBy,
      now,
      now,
    );
    this.audit('project.created', {
      entityType: 'project',
      entityId: result.lastInsertRowid,
      payload: { projectKey: key, name: cleanName, aliases: cleanAliases },
    });
    return this.getProject(mailboxId, result.lastInsertRowid);
  }

  getPrecisionCorrection(mailboxId, graphId) {
    const row = this.db.prepare(`
      SELECT c.* FROM precision_corrections c
      JOIN messages m ON m.id = c.message_id
      WHERE m.mailbox_id = ? AND m.graph_id = ?
    `).get(mailboxId, graphId);
    if (!row) return null;
    return {
      messageId: graphId,
      overrides: parseJson(row.overrides_json, {}),
      reasonCode: row.reason_code,
      note: row.note,
      savedAt: row.saved_at,
      updatedAt: row.updated_at,
    };
  }

  savePrecisionCorrection(mailboxId, graphId, correction) {
    const message = this.getMessageRecord(mailboxId, graphId);
    if (!message) throw new Error(`Cannot save precision correction for unknown message: ${graphId}.`);
    const overrides = correction?.overrides && typeof correction.overrides === 'object'
      ? correction.overrides
      : {};
    if (!Object.keys(overrides).length) throw new Error('Precision correction requires at least one override.');
    const savedAt = correction.savedAt || this.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO precision_corrections(
          message_id, mailbox_id, overrides_json, reason_code, note, saved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          overrides_json = excluded.overrides_json,
          reason_code = excluded.reason_code,
          note = excluded.note,
          saved_at = excluded.saved_at,
          updated_at = excluded.updated_at
      `).run(
        message.id,
        mailboxId,
        jsonText(overrides, {}),
        correction.reasonCode || '',
        correction.note || '',
        savedAt,
        this.now(),
      );
      this.db.prepare(`
        INSERT INTO precision_correction_events(
          message_id, mailbox_id, overrides_json, reason_code, note, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        mailboxId,
        jsonText(overrides, {}),
        correction.reasonCode || '',
        correction.note || '',
        savedAt,
      );
      this.audit('precision.correction.saved', {
        entityType: 'message',
        entityId: graphId,
        payload: { fields: Object.keys(overrides), reasonCode: correction.reasonCode || '' },
      });
    });
    return this.getPrecisionCorrection(mailboxId, graphId);
  }

  getPrecisionClassification(mailboxId, graphId) {
    const row = this.db.prepare(`
      SELECT pc.*, m.graph_id, p.name AS project_name, p.project_key
      FROM precision_classifications pc
      JOIN messages m ON m.id = pc.message_id
      LEFT JOIN projects p ON p.id = pc.primary_project_id
      WHERE m.mailbox_id = ? AND m.graph_id = ?
    `).get(mailboxId, graphId);
    return precisionRow(row);
  }

  getPrecisionClassificationMap(mailboxId) {
    const rows = this.db.prepare(`
      SELECT pc.*, m.graph_id, p.name AS project_name, p.project_key
      FROM precision_classifications pc
      JOIN messages m ON m.id = pc.message_id
      LEFT JOIN projects p ON p.id = pc.primary_project_id
      WHERE m.mailbox_id = ?
      ORDER BY pc.updated_at DESC
    `).all(mailboxId);
    return Object.fromEntries(rows.map((row) => [row.graph_id, precisionRow(row)]));
  }

  savePrecisionClassification(mailboxId, graphId, classification) {
    const message = this.getMessageRecord(mailboxId, graphId);
    if (!message) throw new Error(`Cannot save precision classification for unknown message: ${graphId}.`);
    if (!PRECISION_WORK_STATES.has(classification.workState)) throw new Error('Invalid precision work state.');
    if (!PRECISION_NEXT_ACTORS.has(classification.nextActor)) throw new Error('Invalid precision next actor.');
    if (!PRECISION_PRIORITIES.has(classification.priority)) throw new Error('Invalid precision priority.');
    if (!PRECISION_PROJECT_RESOLUTIONS.has(classification.projectResolution)) throw new Error('Invalid project resolution.');
    if (!PRECISION_DUE.has(classification.duePrecision || 'none')) throw new Error('Invalid due precision.');
    if (classification.primaryProjectId != null) {
      const project = this.getProject(mailboxId, classification.primaryProjectId);
      if (!project || project.status !== 'active') throw new Error('Primary project must reference an active project in the same mailbox.');
    }
    const fingerprint = String(classification.fingerprint || digest(jsonText(classification, {})));
    const existing = this.db.prepare('SELECT fingerprint FROM precision_classifications WHERE message_id = ?')
      .get(message.id);
    const now = this.now();
    const analyzedAt = classification.analyzedAt || now;
    const snapshot = {
      ...classification,
      fingerprint,
      messageId: graphId,
    };
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO precision_classifications(
          message_id, mailbox_id, work_state, next_actor, priority,
          due_text, due_at, due_precision, primary_project_id, project_resolution,
          project_candidate_json, signals_json, evidence_json, confidence_json,
          review_reasons_json, source, provider, model, prompt_version,
          review_status, fingerprint, analyzed_at, corrected_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          mailbox_id = excluded.mailbox_id,
          work_state = excluded.work_state,
          next_actor = excluded.next_actor,
          priority = excluded.priority,
          due_text = excluded.due_text,
          due_at = excluded.due_at,
          due_precision = excluded.due_precision,
          primary_project_id = excluded.primary_project_id,
          project_resolution = excluded.project_resolution,
          project_candidate_json = excluded.project_candidate_json,
          signals_json = excluded.signals_json,
          evidence_json = excluded.evidence_json,
          confidence_json = excluded.confidence_json,
          review_reasons_json = excluded.review_reasons_json,
          source = excluded.source,
          provider = excluded.provider,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          review_status = excluded.review_status,
          fingerprint = excluded.fingerprint,
          analyzed_at = excluded.analyzed_at,
          corrected_at = excluded.corrected_at,
          updated_at = excluded.updated_at
      `).run(
        message.id,
        mailboxId,
        classification.workState,
        classification.nextActor,
        classification.priority,
        classification.dueText || '',
        classification.dueAt || null,
        classification.duePrecision || 'none',
        classification.primaryProjectId || null,
        classification.projectResolution,
        jsonText(classification.projectCandidate, {}),
        jsonText(classification.signals, []),
        jsonText(classification.evidence, {}),
        jsonText(classification.confidence, {}),
        jsonText(classification.reviewReasons, []),
        classification.source || 'rules',
        classification.provider || 'rules',
        classification.model || '',
        classification.promptVersion || '',
        classification.reviewStatus || 'auto',
        fingerprint,
        analyzedAt,
        classification.correctedAt || null,
        now,
        now,
      );
      if (!existing || existing.fingerprint !== fingerprint) {
        this.db.prepare(`
          INSERT OR IGNORE INTO precision_classification_events(
            message_id, mailbox_id, fingerprint, work_state, next_actor,
            priority, due_text, due_at, primary_project_id, project_resolution,
            snapshot_json, source, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          message.id,
          mailboxId,
          fingerprint,
          classification.workState,
          classification.nextActor,
          classification.priority,
          classification.dueText || '',
          classification.dueAt || null,
          classification.primaryProjectId || null,
          classification.projectResolution,
          jsonText(snapshot, {}),
          classification.source || 'rules',
          now,
        );
      }
    });
    return this.getPrecisionClassification(mailboxId, graphId);
  }

  getPrecisionEvents(mailboxId, graphId, { limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT e.* FROM precision_classification_events e
      JOIN messages m ON m.id = e.message_id
      WHERE m.mailbox_id = ? AND m.graph_id = ?
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
    `).all(mailboxId, graphId, boundedLimit(limit, 25, 200)).map((row) => ({
      id: number(row.id),
      fingerprint: row.fingerprint,
      workState: row.work_state,
      nextActor: row.next_actor,
      priority: row.priority,
      dueText: row.due_text,
      dueAt: row.due_at || null,
      primaryProjectId: row.primary_project_id == null ? null : number(row.primary_project_id),
      projectResolution: row.project_resolution,
      source: row.source,
      snapshot: parseJson(row.snapshot_json, {}),
      createdAt: row.created_at,
    }));
  }

  precisionSummary(mailboxId) {
    const rows = this.db.prepare(`
      SELECT work_state, next_actor, priority, project_resolution, review_status, COUNT(*) AS count
      FROM precision_classifications
      WHERE mailbox_id = ?
      GROUP BY work_state, next_actor, priority, project_resolution, review_status
    `).all(mailboxId);
    const result = {
      total: 0,
      states: Object.fromEntries([...PRECISION_WORK_STATES].map((value) => [value, 0])),
      actors: Object.fromEntries([...PRECISION_NEXT_ACTORS].map((value) => [value, 0])),
      priorities: Object.fromEntries([...PRECISION_PRIORITIES].map((value) => [value, 0])),
      projectResolution: Object.fromEntries([...PRECISION_PROJECT_RESOLUTIONS].map((value) => [value, 0])),
      reviewRequired: 0,
      corrected: 0,
    };
    for (const row of rows) {
      const count = number(row.count);
      result.total += count;
      result.states[row.work_state] += count;
      result.actors[row.next_actor] += count;
      result.priorities[row.priority] += count;
      result.projectResolution[row.project_resolution] += count;
      if (row.review_status === 'review_required') result.reviewRequired += count;
      if (row.review_status === 'corrected') result.corrected += count;
    }
    return result;
  }

  intelligentSearch(mailboxId, parsedQuery, { limit = 25 } = {}) {
    const filters = parsedQuery?.filters || {};
    const residualTokens = String(parsedQuery?.residualText || '')
      .normalize('NFKC')
      .match(/[\p{L}\p{N}_-]+/gu) || [];
    const clauses = ['m.mailbox_id = ?', 'm.deleted_at IS NULL'];
    const params = [mailboxId];
    const joins = [];
    let rankSelect = '0 AS rank';
    if (residualTokens.length) {
      const ftsQuery = residualTokens.slice(0, 12)
        .map((token) => `"${token.replace(/"/g, '""')}"`)
        .join(' AND ');
      joins.push('JOIN message_fts ON message_fts.rowid = m.id');
      clauses.push('message_fts MATCH ?');
      params.push(ftsQuery);
      rankSelect = 'bm25(message_fts) AS rank';
    }

    const appendIn = (column, values) => {
      if (!Array.isArray(values) || !values.length) return;
      clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    appendIn('pc.work_state', filters.workStates);
    appendIn('pc.next_actor', filters.nextActors);
    appendIn('pc.priority', filters.priorities);
    appendIn('pc.project_resolution', filters.projectResolution);

    for (const signal of filters.signals || []) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(pc.signals_json) WHERE json_each.value = ?)');
      params.push(signal);
    }
    if (filters.reviewOnly) clauses.push('pc.review_status = \'review_required\'');
    if (filters.dueRange?.requiresDue === true) clauses.push('pc.due_at IS NOT NULL');
    if (filters.dueRange?.requiresDue === false) clauses.push('pc.due_at IS NULL');
    if (filters.dueRange?.from) {
      clauses.push('pc.due_at >= ?');
      params.push(filters.dueRange.from);
    }
    if (filters.dueRange?.before) {
      clauses.push('pc.due_at < ?');
      params.push(filters.dueRange.before);
    }
    if (filters.project) {
      const pattern = `%${normalizeProjectName(filters.project)}%`;
      clauses.push(`(
        p.normalized_name LIKE ?
        OR EXISTS (
          SELECT 1 FROM json_each(p.aliases_json)
          WHERE LOWER(CAST(json_each.value AS TEXT)) LIKE ?
        )
        OR LOWER(pc.project_candidate_json) LIKE ?
      )`);
      params.push(pattern, pattern, pattern);
    }

    const rows = this.db.prepare(`
      SELECT m.*, ${rankSelect}
      FROM messages m
      JOIN precision_classifications pc ON pc.message_id = m.id
      LEFT JOIN projects p ON p.id = pc.primary_project_id
      ${joins.join('\n')}
      WHERE ${clauses.join(' AND ')}
      ORDER BY
        CASE pc.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        CASE pc.work_state WHEN 'review_required' THEN 1 WHEN 'decision_required' THEN 2 WHEN 'action_required' THEN 3 WHEN 'waiting' THEN 4 ELSE 5 END,
        CASE WHEN pc.due_at IS NULL THEN 1 ELSE 0 END,
        pc.due_at ASC,
        rank ASC,
        COALESCE(m.received_at, m.sent_at, m.first_seen_at) DESC
      LIMIT ?
    `).all(...params, boundedLimit(limit, 25, 100));

    return rows.map((row) => ({
      message: rowToMessage(row),
      classification: this.getPrecisionClassification(mailboxId, row.graph_id),
      rank: Number(row.rank || 0),
    }));
  }

  saveFeedback(mailboxId, graphId, feedback) {
    const message = this.getMessageRecord(mailboxId, graphId);
    if (!message) throw new Error(`Cannot save feedback for unknown message: ${graphId}.`);
    if (!FEEDBACK_VALUES.has(feedback.userStatus)) throw new Error('Invalid feedback status.');
    const now = feedback.savedAt || this.now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO message_feedback(
          message_id, user_status, reason_code, reason_label, note,
          sender_snapshot, subject_snapshot, subject_tokens_json,
          saved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          user_status = excluded.user_status,
          reason_code = excluded.reason_code,
          reason_label = excluded.reason_label,
          note = excluded.note,
          sender_snapshot = excluded.sender_snapshot,
          subject_snapshot = excluded.subject_snapshot,
          subject_tokens_json = excluded.subject_tokens_json,
          saved_at = excluded.saved_at,
          updated_at = excluded.updated_at
      `).run(
        message.id,
        feedback.userStatus,
        feedback.reasonCode || '',
        feedback.reasonLabel || '',
        feedback.note || '',
        feedback.sender || message.sender_email || '',
        feedback.subject || message.subject || '',
        jsonText(feedback.subjectTokens, []),
        now,
        this.now(),
      );
      this.db.prepare(`
        INSERT INTO feedback_events(
          message_id, user_status, reason_code, reason_label, note, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        feedback.userStatus,
        feedback.reasonCode || '',
        feedback.reasonLabel || '',
        feedback.note || '',
        now,
      );
    });
    return this.getFeedback(mailboxId, graphId);
  }

  getFeedback(mailboxId, graphId) {
    const row = this.db.prepare(`
      SELECT f.*, m.graph_id, m.sender_email, m.subject
      FROM message_feedback f
      JOIN messages m ON m.id = f.message_id
      WHERE m.mailbox_id = ? AND m.graph_id = ?
    `).get(mailboxId, graphId);
    if (!row) return null;
    return {
      messageId: row.graph_id,
      userStatus: row.user_status,
      reasonCode: row.reason_code,
      reasonLabel: row.reason_label,
      note: row.note,
      sender: row.sender_snapshot || row.sender_email,
      subject: row.subject_snapshot || row.subject,
      subjectTokens: parseJson(row.subject_tokens_json, []),
      savedAt: row.saved_at,
    };
  }

  getFeedbackMap(mailboxId) {
    const rows = this.db.prepare(`
      SELECT f.*, m.graph_id, m.sender_email, m.subject
      FROM message_feedback f
      JOIN messages m ON m.id = f.message_id
      WHERE m.mailbox_id = ?
      ORDER BY f.saved_at DESC
    `).all(mailboxId);
    return Object.fromEntries(rows.map((row) => [row.graph_id, {
      messageId: row.graph_id,
      userStatus: row.user_status,
      reasonCode: row.reason_code,
      reasonLabel: row.reason_label,
      note: row.note,
      sender: row.sender_snapshot || row.sender_email,
      subject: row.subject_snapshot || row.subject,
      subjectTokens: parseJson(row.subject_tokens_json, []),
      savedAt: row.saved_at,
    }]));
  }

  getAnalysis(mailboxId, graphId, cacheKey) {
    const row = this.db.prepare(`
      SELECT a.* FROM message_analysis a
      JOIN messages m ON m.id = a.message_id
      WHERE m.mailbox_id = ? AND m.graph_id = ? AND a.cache_key = ?
    `).get(mailboxId, graphId, cacheKey);
    return row ? this.analysisRow(row) : null;
  }

  saveAnalysis(mailboxId, graphId, cacheKey, analysis) {
    const message = this.getMessageRecord(mailboxId, graphId);
    if (!message) throw new Error(`Cannot save analysis for unknown message: ${graphId}.`);
    const status = STATUS_VALUES.has(analysis.status) ? analysis.status : 'active';
    const now = this.now();
    this.db.prepare(`
      INSERT INTO message_analysis(
        message_id, cache_key, source, provider, model, prompt_version,
        status, confidence, summary_json, evidence_json, actions_json,
        rationale, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, cache_key) DO UPDATE SET
        source = excluded.source,
        provider = excluded.provider,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        status = excluded.status,
        confidence = excluded.confidence,
        summary_json = excluded.summary_json,
        evidence_json = excluded.evidence_json,
        actions_json = excluded.actions_json,
        rationale = excluded.rationale,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `).run(
      message.id,
      cacheKey,
      analysis.source || 'ai',
      analysis.provider || 'rules',
      analysis.model || '',
      analysis.promptVersion || '',
      status,
      Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : null,
      jsonText(analysis.summary, []),
      jsonText(analysis.evidenceItems, []),
      jsonText(analysis.nextActions, []),
      analysis.aiRationale || '',
      analysis.errorCode || '',
      analysis.errorMessage || '',
      now,
      now,
    );
    return this.getAnalysis(mailboxId, graphId, cacheKey);
  }

  analysisRow(row) {
    return {
      status: row.status,
      summary: parseJson(row.summary_json, []),
      evidenceItems: parseJson(row.evidence_json, []),
      nextActions: parseJson(row.actions_json, []),
      aiRationale: row.rationale || '',
      aiProvider: row.provider || 'rules',
      aiModel: row.model || '',
      promptVersion: row.prompt_version || '',
      source: row.source,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    };
  }

  searchMessages(mailboxId, query, { limit = 25 } = {}) {
    const tokens = String(query || '')
      .normalize('NFKC')
      .match(/[\p{L}\p{N}_-]+/gu) || [];
    if (!tokens.length) return [];
    const ftsQuery = tokens.slice(0, 12).map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
    const rows = this.db.prepare(`
      SELECT m.*, bm25(message_fts) AS rank
      FROM message_fts
      JOIN messages m ON m.id = message_fts.rowid
      WHERE message_fts MATCH ? AND m.mailbox_id = ? AND m.deleted_at IS NULL
      ORDER BY rank, COALESCE(m.received_at, m.sent_at, m.first_seen_at) DESC
      LIMIT ?
    `).all(ftsQuery, mailboxId, boundedLimit(limit));
    return rows.map((row) => ({ ...rowToMessage(row), rank: Number(row.rank) }));
  }

  getSyncStatus(mailboxId) {
    const folders = this.db.prepare(`
      SELECT id, graph_id, well_known_name, display_name, sync_state,
             CASE WHEN delta_link <> '' THEN 1 ELSE 0 END AS has_delta_cursor,
             CASE WHEN next_link <> '' THEN 1 ELSE 0 END AS has_resume_cursor,
             last_sync_started_at, last_sync_completed_at,
             last_error_code, last_error_message
      FROM mail_folders WHERE mailbox_id = ? ORDER BY id
    `).all(mailboxId);
    const latestRuns = this.db.prepare(`
      SELECT r.* FROM sync_runs r
      WHERE r.mailbox_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 20
    `).all(mailboxId);
    return { folders, latestRuns };
  }

  recordLegacyImport(record) {
    return this.db.prepare(`
      INSERT INTO legacy_imports(
        source_name, source_digest, mailbox_count, message_count,
        feedback_count, analysis_count, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_digest) DO NOTHING
    `).run(
      record.sourceName,
      record.sourceDigest,
      record.mailboxCount || 0,
      record.messageCount || 0,
      record.feedbackCount || 0,
      record.analysisCount || 0,
      record.importedAt || this.now(),
    );
  }

  hasLegacyImport(sourceDigest) {
    return Boolean(this.db.prepare('SELECT 1 FROM legacy_imports WHERE source_digest = ?').get(sourceDigest));
  }

  audit(eventType, { entityType = '', entityId = '', payload = {} } = {}) {
    this.db.prepare(`
      INSERT INTO audit_events(event_type, entity_type, entity_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventType, entityType, String(entityId), jsonText(payload, {}), this.now());
  }

  recordBackupManifest({
    backupName,
    checksumSha256,
    sizeBytes,
    schemaVersion,
    recordCounts = {},
    integrity = {},
    createdAt = this.now(),
    verifiedAt = this.now(),
  }) {
    if (!backupName || !checksumSha256) throw new Error('backupName and checksumSha256 are required.');
    this.db.prepare(`
      INSERT INTO backup_manifests(
        backup_name, checksum_sha256, size_bytes, schema_version,
        record_counts_json, integrity_json, created_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(backup_name) DO UPDATE SET
        checksum_sha256 = excluded.checksum_sha256,
        size_bytes = excluded.size_bytes,
        schema_version = excluded.schema_version,
        record_counts_json = excluded.record_counts_json,
        integrity_json = excluded.integrity_json,
        created_at = excluded.created_at,
        verified_at = excluded.verified_at
    `).run(
      String(backupName),
      String(checksumSha256),
      Math.max(Number(sizeBytes || 0), 0),
      Math.max(Number(schemaVersion || 0), 0),
      jsonText(recordCounts, {}),
      jsonText(integrity, {}),
      String(createdAt),
      String(verifiedAt),
    );
    return this.db.prepare('SELECT * FROM backup_manifests WHERE backup_name = ?').get(String(backupName));
  }

  listBackupManifests({ limit = 20 } = {}) {
    return this.db.prepare(`
      SELECT backup_name, checksum_sha256, size_bytes, schema_version,
             record_counts_json, integrity_json, created_at, verified_at
      FROM backup_manifests
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(boundedLimit(limit, 20, 100)).map((row) => ({
      backupName: row.backup_name,
      checksumSha256: row.checksum_sha256,
      sizeBytes: number(row.size_bytes),
      schemaVersion: number(row.schema_version),
      recordCounts: parseJson(row.record_counts_json, {}),
      integrity: parseJson(row.integrity_json, {}),
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
    }));
  }

  createOperatorJob({
    jobKey,
    jobType,
    input = {},
    maxAttempts = 3,
    queuedAt = this.now(),
  }) {
    if (!jobKey || !jobType) throw new Error('jobKey and jobType are required.');
    this.db.prepare(`
      INSERT INTO operator_jobs(
        job_key, job_type, status, attempt_count, max_attempts,
        input_json, result_json, queued_at, updated_at
      ) VALUES (?, ?, 'queued', 0, ?, ?, '{}', ?, ?)
    `).run(
      String(jobKey),
      String(jobType),
      Math.min(Math.max(Number(maxAttempts || 3), 1), 10),
      jsonText(input, {}),
      String(queuedAt),
      String(queuedAt),
    );
    return this.getOperatorJob(jobKey);
  }

  getOperatorJob(jobKey) {
    const row = this.db.prepare('SELECT * FROM operator_jobs WHERE job_key = ?').get(String(jobKey));
    return row ? this.operatorJobRow(row) : null;
  }

  markOperatorJobRunning(jobKey, attempt, startedAt = this.now()) {
    this.db.prepare(`
      UPDATE operator_jobs
      SET status = 'running', attempt_count = ?, started_at = COALESCE(started_at, ?),
          error_code = '', error_message = '', updated_at = ?
      WHERE job_key = ?
    `).run(Math.max(Number(attempt || 1), 1), String(startedAt), String(startedAt), String(jobKey));
    return this.getOperatorJob(jobKey);
  }

  completeOperatorJob(jobKey, result = {}, completedAt = this.now()) {
    this.db.prepare(`
      UPDATE operator_jobs
      SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
      WHERE job_key = ?
    `).run(jsonText(result, {}), String(completedAt), String(completedAt), String(jobKey));
    return this.getOperatorJob(jobKey);
  }

  failOperatorJob(jobKey, error, {
    deadLetter = false,
    result = {},
    completedAt = this.now(),
  } = {}) {
    const code = String(error?.code || 'OPERATOR_JOB_FAILED').slice(0, 160);
    const message = String(error instanceof Error ? error.message : error || 'Operator job failed.').slice(0, 1000);
    const status = deadLetter ? 'dead-letter' : 'failed';
    this.db.prepare(`
      UPDATE operator_jobs
      SET status = ?, result_json = ?, error_code = ?, error_message = ?,
          completed_at = ?, updated_at = ?
      WHERE job_key = ?
    `).run(status, jsonText(result, {}), code, message, String(completedAt), String(completedAt), String(jobKey));
    return this.getOperatorJob(jobKey);
  }

  listOperatorJobs({ limit = 50, status = '' } = {}) {
    const bounded = boundedLimit(limit, 50, 200);
    const rows = status
      ? this.db.prepare(`
          SELECT * FROM operator_jobs WHERE status = ? ORDER BY updated_at DESC, id DESC LIMIT ?
        `).all(String(status), bounded)
      : this.db.prepare(`
          SELECT * FROM operator_jobs ORDER BY updated_at DESC, id DESC LIMIT ?
        `).all(bounded);
    return rows.map((row) => this.operatorJobRow(row));
  }

  operatorJobRow(row) {
    return {
      id: number(row.id),
      jobKey: row.job_key,
      jobType: row.job_type,
      status: row.status,
      attemptCount: number(row.attempt_count),
      maxAttempts: number(row.max_attempts),
      input: parseJson(row.input_json, {}),
      result: parseJson(row.result_json, {}),
      errorCode: row.error_code || '',
      errorMessage: row.error_message || '',
      queuedAt: row.queued_at,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      updatedAt: row.updated_at,
    };
  }

  recordDeadLetter({
    jobId = null,
    eventType,
    entityType = '',
    entityId = '',
    errorCode = '',
    errorMessage = '',
    payload = {},
    createdAt = this.now(),
  }) {
    if (!eventType) throw new Error('eventType is required.');
    const result = this.db.prepare(`
      INSERT INTO dead_letter_events(
        job_id, event_type, entity_type, entity_id, error_code,
        error_message, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId == null ? null : Number(jobId),
      String(eventType),
      String(entityType),
      String(entityId),
      String(errorCode).slice(0, 160),
      String(errorMessage).slice(0, 1000),
      jsonText(payload, {}),
      String(createdAt),
    );
    return this.db.prepare('SELECT * FROM dead_letter_events WHERE id = ?').get(Number(result.lastInsertRowid));
  }

  listDeadLetters({ limit = 50, includeResolved = false } = {}) {
    const bounded = boundedLimit(limit, 50, 200);
    const rows = includeResolved
      ? this.db.prepare('SELECT * FROM dead_letter_events ORDER BY created_at DESC, id DESC LIMIT ?').all(bounded)
      : this.db.prepare(`
          SELECT * FROM dead_letter_events
          WHERE resolved_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(bounded);
    return rows.map((row) => ({
      id: number(row.id),
      jobId: row.job_id == null ? null : number(row.job_id),
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      payload: parseJson(row.payload_json, {}),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at || null,
    }));
  }

  counts() {
    const tables = [
      'mailboxes',
      'mail_folders',
      'persons',
      'threads',
      'messages',
      'attachments',
      'message_feedback',
      'message_analysis',
      'observations',
      'operator_jobs',
      'dead_letter_events',
      'outbox_items',
      'backup_manifests',
      'projects',
      'precision_classifications',
      'precision_classification_events',
      'precision_corrections',
      'precision_correction_events',
    ];
    return Object.fromEntries(tables.map((table) => [
      table,
      number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
    ]));
  }

  integrityCheck() {
    const quick = this.db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_check').all();
    const ok = quick.length === 1 && quick[0] === 'ok' && foreignKeys.length === 0;
    return { ok, quickCheck: quick, foreignKeyErrors: foreignKeys };
  }

  storageStatus() {
    const migration = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    const integrity = this.integrityCheck();
    const sizeBytes = existsSync(this.databasePath) ? statSync(this.databasePath).size : 0;
    return {
      ready: integrity.ok,
      schemaVersion: number(migration.version),
      sizeBytes,
      counts: this.counts(),
      integrity,
    };
  }

  backupTo(targetPath) {
    const target = resolve(targetPath);
    if (!isAbsolute(targetPath)) throw new Error('Backup target must be absolute.');
    if (target === this.databasePath) throw new Error('Backup target must differ from the live database.');
    if (existsSync(target)) throw new Error('Backup target already exists.');
    const backupDirectory = dirname(target);
    ensurePrivateDirectorySync(backupDirectory);
    this.db.exec('PRAGMA wal_checkpoint(FULL);');
    this.db.exec(`VACUUM INTO ${sqlLiteral(target)};`);
    chmodSync(target, 0o600);
    const backup = new DatabaseSync(target, { readOnly: true });
    try {
      backup.exec('PRAGMA foreign_keys = ON;');
      const quick = backup.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
      const foreignKeys = backup.prepare('PRAGMA foreign_key_check').all();
      if (!(quick.length === 1 && quick[0] === 'ok' && foreignKeys.length === 0)) {
        throw new Error('Backup integrity verification failed.');
      }
    } finally {
      backup.close();
    }
    return { path: target, sizeBytes: statSync(target).size, createdAt: this.now() };
  }

  close() {
    if (this.closed) return;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
    this.closed = true;
  }
}

export const sqliteStoreInternals = {
  digest,
  normalizeEmail,
  normalizeProjectKey,
  normalizeProjectName,
  normalizeSubject,
  parseJson,
  precisionRow,
  projectRow,
  rowToMessage,
};
