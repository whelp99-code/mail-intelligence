import { createHash, timingSafeEqual } from 'node:crypto';
import { annotateReplyGaps } from './reply-draft-pipeline.js';
import { markHandledElsewhere, undoHandledElsewhere, resolveHandledMessage } from './handled-elsewhere.js';

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message || code), { statusCode, code });
}

function equal(value, expected) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function sessionActor(session) {
  return `session:${createHash('sha256').update(String(session.token || '')).digest('hex').slice(0, 24)}`;
}

function replyGapFor(db, mailboxId, message) {
  const classification = db.prepare('SELECT work_state FROM precision_classifications WHERE message_id = ?').get(message.id);
  const folder = message.folder_id
    ? db.prepare('SELECT well_known_name, display_name FROM mail_folders WHERE id = ?').get(message.folder_id)
    : null;
  const [annotated] = annotateReplyGaps(db, mailboxId, [{
    id: message.graph_id,
    graphId: message.graph_id,
    conversationId: message.conversation_id,
    subject: message.subject,
    normalized_subject: message.normalized_subject,
    sender_email: message.sender_email,
    received_at: message.received_at,
    classification: { workState: classification?.work_state || '' },
    well_known_name: folder?.well_known_name || '',
    display_name: folder?.display_name || '',
  }]);
  return Boolean(annotated?.replyGap);
}

export function createHandledElsewhereApi({
  getStore,
  getMailbox,
  getSession,
  readBody,
  accessKeyRequired = false,
}) {
  return async function handledElsewhereApi(req, url) {
    if (url.pathname !== '/api/messages/handled-elsewhere') fail(404, 'NOT_FOUND', 'Not found.');
    if (String(req.headers.authorization || '').startsWith('Bearer ')) fail(401, 'SESSION_REQUIRED', 'A browser session is required.');
    if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const session = getSession(req);
    if (!session?.token || !session.csrfToken) fail(401, 'SESSION_REQUIRED', 'A browser session is required.');
    if (!equal(req.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REQUIRED', 'A valid CSRF token is required.');
    if (req.headers.origin !== url.origin) fail(403, 'ORIGIN_REJECTED', 'Cross-origin state changes are not allowed.');
    if (accessKeyRequired && String(req.headers['x-mail-intelligence-request'] || '') !== '1') {
      fail(403, 'MUTATION_PROTECTION_REQUIRED', 'Mutation protection header is required.');
    }
    const body = await readBody(req);
    const allowed = new Set(['messageId', 'channel', 'note', 'undo']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
      fail(400, 'INVALID_FIELDS', 'Unexpected fields.');
    }
    const store = getStore();
    const mailbox = getMailbox();
    const actor = sessionActor(session);
    if (body.undo === true) {
      if (body.channel != null || body.note != null) fail(400, 'INVALID_FIELDS', 'Undo does not take a channel.');
      const undone = undoHandledElsewhere({
        db: store.db,
        mailboxId: mailbox.id,
        messageId: body.messageId,
        actor,
      });
      const message = resolveHandledMessage(store.db, mailbox.id, body.messageId);
      return {
        status: 200,
        body: { handledElsewhere: null, undone: true, replyGap: replyGapFor(store.db, mailbox.id, message), cancelledDrafts: 0 },
      };
    }
    if (body.undo != null) fail(400, 'INVALID_FIELDS', 'undo must be true.');
    const marked = markHandledElsewhere({
      db: store.db,
      mailboxId: mailbox.id,
      messageId: body.messageId,
      channel: body.channel,
      note: body.note,
      actor,
    });
    const message = resolveHandledMessage(store.db, mailbox.id, marked.handledElsewhere.messageId);
    return {
      status: 200,
      body: {
        handledElsewhere: marked.handledElsewhere,
        undone: false,
        replyGap: replyGapFor(store.db, mailbox.id, message),
        cancelledDrafts: marked.cancelledDrafts,
      },
    };
  };
}
