import { MailSendDrafts } from './mail-send-drafts.js';

export const HANDLED_ELSEWHERE_CHANNELS = Object.freeze(['kakao', 'phone', 'in_person', 'other']);
export const HANDLED_ELSEWHERE_REASON = '외부에서 회신함';
export const HANDLED_ELSEWHERE_ACTOR = 'system:handled-elsewhere';
const NOTE_LIMIT = 500;

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message || code), { statusCode, code });
}

function tableColumns(db, table) {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table);
  if (!exists) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function assertActor(actor) {
  if (typeof actor !== 'string' || !actor.startsWith('session:') || actor.length > 160) {
    fail(403, 'HUMAN_APPROVAL_REQUIRED', 'A browser session is required.');
  }
}

function normalizeNote(note) {
  const value = String(note || '').trim();
  if (value.length > NOTE_LIMIT) fail(400, 'NOTE_TOO_LONG', 'Note is too long.');
  return value;
}

function normalizeChannel(channel) {
  const value = String(channel || '').trim();
  if (!HANDLED_ELSEWHERE_CHANNELS.includes(value)) fail(400, 'INVALID_CHANNEL', 'Channel must be kakao, phone, in_person, or other.');
  return value;
}

export function resolveHandledMessage(db, mailboxId, messageId) {
  const numeric = typeof messageId === 'number' ? messageId : (/^\d+$/.test(String(messageId || '').trim()) ? Number(messageId) : null);
  if (numeric != null) {
    if (!Number.isSafeInteger(numeric) || numeric < 1) fail(400, 'INVALID_MESSAGE', 'Message id is invalid.');
    return db.prepare(`
      SELECT id, graph_id, mailbox_id, subject, normalized_subject, sender_email, received_at, conversation_id, folder_id
      FROM messages WHERE id = ? AND mailbox_id = ? AND deleted_at IS NULL
    `).get(numeric, mailboxId) || null;
  }
  const graphId = String(messageId || '').trim();
  if (!graphId || graphId.length > 2048) fail(400, 'INVALID_MESSAGE', 'Message id is invalid.');
  return db.prepare(`
    SELECT id, graph_id, mailbox_id, subject, normalized_subject, sender_email, received_at, conversation_id, folder_id
    FROM messages WHERE graph_id = ? AND mailbox_id = ? AND deleted_at IS NULL
  `).get(graphId, mailboxId) || null;
}

function publicMarker(row) {
  if (!row || row.undone_at) return null;
  return {
    messageId: row.message_id,
    graphId: row.graph_id,
    channel: row.channel,
    note: row.note || '',
    actor: row.actor,
    markedAt: row.marked_at,
  };
}

export function getHandledElsewhere(db, mailboxId, messageId) {
  if (!tableColumns(db, 'message_handled_elsewhere').has('message_id')) return null;
  const message = resolveHandledMessage(db, mailboxId, messageId);
  if (!message) return null;
  const row = db.prepare(`
    SELECT h.message_id, h.channel, h.note, h.actor, h.marked_at, h.undone_at, m.graph_id
    FROM message_handled_elsewhere h
    JOIN messages m ON m.id = h.message_id
    WHERE h.message_id = ? AND h.mailbox_id = ?
  `).get(message.id, mailboxId);
  return publicMarker(row);
}

export function loadActiveHandledElsewhere(db, mailboxId = null) {
  if (!db || !tableColumns(db, 'message_handled_elsewhere').has('message_id')) {
    return { byId: new Map(), byGraph: new Map(), ids: new Set() };
  }
  const params = [];
  const mailbox = mailboxId == null ? '' : ' AND h.mailbox_id = ?';
  if (mailboxId != null) params.push(mailboxId);
  const rows = db.prepare(`
    SELECT h.message_id, h.mailbox_id, h.channel, h.note, h.actor, h.marked_at, h.undone_at, m.graph_id
    FROM message_handled_elsewhere h
    JOIN messages m ON m.id = h.message_id
    WHERE h.undone_at IS NULL${mailbox}
  `).all(...params);
  const byId = new Map();
  const byGraph = new Map();
  for (const row of rows) {
    const marker = publicMarker(row);
    byId.set(row.message_id, marker);
    if (row.graph_id) byGraph.set(row.graph_id, marker);
  }
  return { byId, byGraph, ids: new Set(byId.keys()) };
}

export function markerForMessage(index, message = {}) {
  if (!index) return null;
  const graphId = message.graphId || message.graph_id || '';
  return index.byGraph.get(message.id)
    || index.byGraph.get(graphId)
    || index.byId.get(Number(message.id))
    || index.byId.get(Number(message.messageId))
    || null;
}

function cancelPendingDrafts(db, mailboxId, messageId, actor) {
  if (!tableColumns(db, 'mail_send_drafts').has('draft_id')) return 0;
  const drafts = new MailSendDrafts(db);
  const pending = db.prepare(`
    SELECT draft_id FROM mail_send_drafts
    WHERE mailbox_id = ? AND message_id = ? AND status = 'needs_approval'
  `).all(mailboxId, messageId);
  let cancelled = 0;
  for (const row of pending) {
    const updated = drafts.cancel(mailboxId, row.draft_id, actor, HANDLED_ELSEWHERE_REASON);
    if (updated?.status === 'cancelled') cancelled += 1;
  }
  return cancelled;
}

export function markHandledElsewhere({ db, mailboxId, messageId, channel, note = '', actor, now = new Date().toISOString() } = {}) {
  if (!db) fail(503, 'STORE_UNAVAILABLE', 'Mail store is not ready.');
  assertActor(actor);
  const chosen = normalizeChannel(channel);
  const text = normalizeNote(note);
  const message = resolveHandledMessage(db, mailboxId, messageId);
  if (!message) fail(404, 'MESSAGE_NOT_FOUND', 'Message was not found.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO message_handled_elsewhere(message_id, mailbox_id, channel, note, actor, marked_at, undone_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(message_id) DO UPDATE SET
        channel = excluded.channel,
        note = excluded.note,
        actor = excluded.actor,
        marked_at = excluded.marked_at,
        undone_at = NULL
    `).run(message.id, mailboxId, chosen, text, actor, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const cancelledDrafts = cancelPendingDrafts(db, mailboxId, message.id, actor);
  return { handledElsewhere: getHandledElsewhere(db, mailboxId, message.id), cancelledDrafts };
}

export function undoHandledElsewhere({ db, mailboxId, messageId, actor, now = new Date().toISOString() } = {}) {
  if (!db) fail(503, 'STORE_UNAVAILABLE', 'Mail store is not ready.');
  assertActor(actor);
  const message = resolveHandledMessage(db, mailboxId, messageId);
  if (!message) fail(404, 'MESSAGE_NOT_FOUND', 'Message was not found.');
  const current = getHandledElsewhere(db, mailboxId, message.id);
  if (!current) fail(404, 'MARKER_NOT_FOUND', 'This message is not marked handled elsewhere.');
  const changed = db.prepare(`
    UPDATE message_handled_elsewhere SET undone_at = ? WHERE message_id = ? AND mailbox_id = ? AND undone_at IS NULL
  `).run(now, message.id, mailboxId);
  if (changed.changes !== 1) fail(404, 'MARKER_NOT_FOUND', 'This message is not marked handled elsewhere.');
  return { handledElsewhere: null, undone: true, message };
}
