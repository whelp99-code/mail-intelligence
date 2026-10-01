import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { classifyMessage } from '../domain/precision-classifier.js';
import { generateSafeDraft } from '../domain/mail-assistant-tools.js';
import { HANDLED_ELSEWHERE_ACTOR, HANDLED_ELSEWHERE_REASON, loadActiveHandledElsewhere, markerForMessage } from './handled-elsewhere.js';

export const REPLY_DRAFT_PIPELINE_VERSION = 'reply-draft-pipeline-v1';
export const PENDING_APPROVALS_PATH = 'data/ops/pending-approvals.jsonl';

export function replyDraftsEnabled(env = process.env) {
  return String(env.MAIL_INTELLIGENCE_REPLY_DRAFTS || '') === '1';
}
export const MORNING_DIGEST_DIR = 'data/ops';
export const REPLY_NEEDED_STATES = Object.freeze(['action_required', 'decision_required']);
export const ALREADY_REPLIED_REASON = '이미 회신함';
export const ALREADY_REPLIED_ACTOR = 'system:already-replied';
const SENT_WELL_KNOWN = new Set(['sentitems', 'sent']);
const SENT_DISPLAY = new Set(['보낸 편지함', '보낸메일함', '보낸 메일함', 'sent items', 'sent mail', 'sent']);
const REPLY_NEEDED = new Set(REPLY_NEEDED_STATES);
const DRAFT_SOURCE = 'jarvis';
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/;
const AUTO_SENDER = /^(?:no[-_.]?reply|noreply|notification|notifications|alert|alerts|mailer-daemon|newsletter|news|marketing|bounce|donotreply)@/i;
const SKIP_TEXT = /unsubscribe|수신\s*거부|뉴스레터|newsletter|mailer-daemon|자동\s*(?:발송|알림|안내)|this is an automated|do not reply|회신\s*하지\s*마/i;
const QUOTE_TEXT = /견적|quote/i;
const TAX_TEXT = /세금계산서|tax\s*invoice/i;
const OUTBOUND_FOLDERS = new Set(['sentitems', 'drafts', 'outbox']);

function textOf(message = {}) {
  return `${message.subject || ''}\n${message.bodyPreview || message.body_preview || ''}\n${message.body || message.body_text || ''}`;
}

export function normalizeReplySubject(value = '') {
  return String(value || '')
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/gi, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function replyCopyKey(message = {}) {
  const internet = String(message.internetMessageId || message.internet_message_id || '').trim();
  if (internet) return `imid:${internet.toLowerCase()}`;
  const sender = senderEmail(message);
  const subject = normalizeReplySubject(message.normalized_subject || message.normalizedSubject || message.subject || '');
  const received = String(message.received_at || message.receivedAt || '');
  return `fb:${sender}|${subject}|${received}`;
}

function senderEmail(message = {}) {
  const raw = message.senderEmail || message.sender_email || message.from || '';
  const match = String(raw).match(EMAIL);
  return match ? match[0].toLowerCase() : '';
}

export function isSkippedInbound(message = {}) {
  const folder = String(message.wellKnownName || message.well_known_name || '').toLowerCase();
  if (message.isDraft || message.is_draft || message.isOutgoing || message.is_outgoing) return 'draft_or_outbound';
  if (OUTBOUND_FOLDERS.has(folder)) return 'outbound_folder';
  if (message.deleted_at || message.deletedAt) return 'deleted';
  if (message.isPromotional || message.is_promotional) return 'newsletter';
  const from = senderEmail(message);
  if (AUTO_SENDER.test(from)) return 'auto_mail';
  if (SKIP_TEXT.test(textOf(message))) return 'newsletter_or_notification';
  return '';
}

export function assessReplyNeed(message = {}, classification = null) {
  const skip = isSkippedInbound(message);
  if (skip) return { needsReply: false, method: 'rules-based', skip, classification: classification || null };
  if (classification && classification.workState) {
    return {
      needsReply: REPLY_NEEDED.has(classification.workState),
      method: classification.method || 'stored',
      skip: '',
      classification,
    };
  }
  const rules = classifyMessage({
    id: String(message.graphId || message.graph_id || message.id || ''),
    subject: message.subject || '',
    body: message.body || message.body_text || message.bodyPreview || message.body_preview || '',
    from: senderEmail(message),
    isPromotional: Boolean(message.isPromotional || message.is_promotional),
  });
  return {
    needsReply: REPLY_NEEDED.has(rules.workState),
    method: 'rules-based',
    skip: '',
    classification: rules,
  };
}

function twoLineSummary(message = {}) {
  const source = String(message.bodyPreview || message.body_preview || message.body || message.body_text || message.subject || '')
    .replace(/\s+/g, ' ')
    .trim();
  const line = source.slice(0, 180) || '(본문 없음)';
  return [line.slice(0, 90), line.slice(90, 180)].join('\n');
}

export function buildReplyDraftPlan(message = {}, classification = null, now = new Date().toISOString()) {
  const assessment = assessReplyNeed(message, classification);
  if (!assessment.needsReply) return { action: 'skip', reason: assessment.skip || 'not_reply_needed', method: assessment.method };
  const to = senderEmail(message);
  if (!to) return { action: 'skip', reason: 'no_reply_address', method: assessment.method };
  const draft = generateSafeDraft({
    message: {
      from: message.from || (message.sender_name ? `${message.sender_name} <${to}>` : to),
      subject: message.subject || '',
      body: message.body || message.body_text || message.bodyPreview || message.body_preview || '',
    },
    classification: assessment.classification || {},
    evidence: { attachmentText: message.attachmentText || '' },
  });
  if (draft.sendAllowed !== false) {
    return { action: 'skip', reason: 'send_path_refused', method: assessment.method };
  }
  const messageId = Number(message.id);
  return {
    action: 'draft',
    method: assessment.method,
    template: draft.templateId,
    request: {
      request_id: `reply.m${messageId}`,
      to: [to],
      subject: draft.subject.replace(/[\r\n]/g, ' ').slice(0, 998),
      body_text: draft.body,
      message_id: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : undefined,
    },
    queue: {
      from: to,
      subject: message.subject || '',
      template: draft.templateId,
      summary: twoLineSummary(message),
      created_at: now,
    },
  };
}

export function quoteOrTaxKind(message = {}) {
  const text = textOf(message);
  if (TAX_TEXT.test(text)) return 'tax_invoice';
  if (QUOTE_TEXT.test(text)) return 'quote';
  return '';
}

function dayBounds(day) {
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function yesterdayUtc(now = new Date()) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function renderMorningDigest({ day, countsByCategory = {}, pending = [], quoteOrTax = [] } = {}) {
  const categories = Object.entries(countsByCategory).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [
    `# Morning digest ${day}`,
    '',
    '## New mail by category',
    ...(categories.length ? categories.map(([name, count]) => `- ${name}: ${count}`) : ['- (none)']),
    '',
    '## Drafts pending approval',
    `- count: ${pending.length}`,
    ...pending.map((item) => `- ${item.draft_id || item.draftId} | ${item.template || ''} | ${item.subject || ''}`),
    '',
    '## Quote / tax-invoice mail',
    `- count: ${quoteOrTax.length}`,
    ...quoteOrTax.map((item) => `- ${item.kind} | ${item.from || ''} | ${item.subject || ''}`),
    '',
  ];
  return lines.join('\n');
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

export function writePendingApprovals(path, rows) {
  ensureParent(path);
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, body ? `${body}\n` : '', { mode: 0o600 });
}

export function appendPendingApproval(path, row) {
  ensureParent(path);
  appendFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function loadInboundMessages(db, { since = null, mailboxId = null } = {}) {
  const clauses = ['m.deleted_at IS NULL', 'm.is_draft = 0'];
  const params = [];
  if (since) {
    clauses.push('m.first_seen_at >= ?');
    params.push(since);
  }
  if (mailboxId != null) {
    clauses.push('m.mailbox_id = ?');
    params.push(mailboxId);
  }
  return db.prepare(`
    SELECT m.id, m.mailbox_id, m.subject, m.normalized_subject, m.sender_email, m.sender_name, m.body_preview, m.body_text,
           m.is_draft, m.is_promotional, m.received_at, m.sent_at, m.first_seen_at, m.graph_id, m.internet_message_id,
           m.conversation_id,
           f.well_known_name, f.display_name,
           pc.work_state, pc.source AS classification_source
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    LEFT JOIN precision_classifications pc ON pc.message_id = m.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY m.id
  `).all(...params).map((row) => ({
    id: row.id,
    mailboxId: row.mailbox_id,
    subject: row.subject,
    normalized_subject: row.normalized_subject,
    internet_message_id: row.internet_message_id,
    sender_email: row.sender_email,
    from: row.sender_name ? `${row.sender_name} <${row.sender_email}>` : row.sender_email,
    body_preview: row.body_preview,
    body_text: row.body_text,
    is_draft: row.is_draft,
    is_promotional: row.is_promotional,
    received_at: row.received_at,
    sent_at: row.sent_at,
    conversation_id: row.conversation_id || '',
    first_seen_at: row.first_seen_at,
    graph_id: row.graph_id,
    well_known_name: row.well_known_name,
    display_name: row.display_name || '',
    classification: row.work_state ? { workState: row.work_state, method: 'stored', source: row.classification_source } : null,
  }));
}

export function existingDraftForMessage(db, mailboxId, messageId) {
  return db.prepare(`
    SELECT draft_id, status FROM mail_send_drafts
    WHERE mailbox_id = ? AND message_id = ? AND status != 'cancelled'
    LIMIT 1
  `).get(mailboxId, messageId) || null;
}

function existingDraftForCopy(db, message) {
  const mailboxId = message.mailboxId || message.mailbox_id;
  const direct = existingDraftForMessage(db, mailboxId, message.id);
  if (direct) return direct;
  const key = replyCopyKey(message);
  const rows = db.prepare(`
    SELECT d.draft_id, d.status, m.internet_message_id, m.sender_email, m.sender_name,
           m.subject, m.normalized_subject, m.received_at
    FROM mail_send_drafts d
    JOIN messages m ON m.id = d.message_id
    WHERE d.mailbox_id = ? AND d.status != 'cancelled'
  `).all(mailboxId);
  const hit = rows.find((row) => replyCopyKey(row) === key);
  return hit ? { draft_id: hit.draft_id, status: hit.status } : null;
}

function tableColumns(db, table) {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table);
  if (!exists) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

export function isSentFolderMessage(message = {}) {
  const wellKnown = String(message.well_known_name || message.wellKnownName || message.folderWellKnownName || '').toLowerCase();
  const display = String(message.display_name || message.displayName || message.folderName || message.folder_display_name || '').toLowerCase();
  if (message.isOutgoing || message.is_outgoing) return true;
  return SENT_WELL_KNOWN.has(wellKnown) || SENT_DISPLAY.has(display);
}

function messageTime(message = {}, preferSent = false) {
  if (preferSent) return String(message.sent_at || message.sentAt || message.received_at || message.receivedAt || '');
  return String(message.received_at || message.receivedAt || message.sent_at || message.sentAt || '');
}

function senderDomain(message = {}) {
  const email = senderEmail(message);
  const domain = email.split('@')[1] || '';
  return domain.toLowerCase();
}

function recipientDomains(message = {}) {
  const raw = [
    ...(Array.isArray(message.to) ? message.to : []),
    ...(Array.isArray(message.toEmails) ? message.toEmails : []),
    ...(Array.isArray(message.toRecipients) ? message.toRecipients.map((item) => item?.emailAddress?.address || item) : []),
  ];
  return raw.map((item) => String(item || '').toLowerCase().split('@')[1] || '').filter(Boolean);
}

export function hasLaterSentReply(inbound = {}, sentMessages = []) {
  const inboundTime = messageTime(inbound, false);
  const conversation = String(inbound.conversation_id || inbound.conversationId || '').trim();
  const subject = normalizeReplySubject(inbound.normalized_subject || inbound.normalizedSubject || inbound.subject || '');
  const domain = senderDomain(inbound);
  return sentMessages.some((sent) => {
    if (!isSentFolderMessage(sent)) return false;
    const sentTime = messageTime(sent, true);
    if (inboundTime && sentTime && sentTime <= inboundTime) return false;
    if (inboundTime && !sentTime) return false;
    const sentConversation = String(sent.conversation_id || sent.conversationId || '').trim();
    if (conversation && sentConversation && conversation === sentConversation) return true;
    const sentSubject = normalizeReplySubject(sent.normalized_subject || sent.normalizedSubject || sent.subject || '');
    return Boolean(subject && sentSubject === subject && domain && recipientDomains(sent).includes(domain));
  });
}

export function needsUnansweredReply(message = {}, sentMessages = []) {
  if (isSentFolderMessage(message)) return false;
  if (message.handledElsewhere || message.handled_elsewhere) return false;
  const state = message.classification?.workState || message.work_state || message.workState || message.precision?.workState || '';
  if (!REPLY_NEEDED.has(state)) return false;
  return !hasLaterSentReply(message, sentMessages);
}

function sentFolderPredicate(columns) {
  const parts = ['lower(COALESCE(f.well_known_name, \'\')) IN (\'sentitems\', \'sent\')'];
  if (columns.has('display_name')) {
    parts.push('lower(COALESCE(f.display_name, \'\')) IN (\'보낸 편지함\', \'보낸메일함\', \'보낸 메일함\', \'sent items\', \'sent mail\', \'sent\')');
  }
  return parts.join(' OR ');
}

export function loadSentReplies(db, { mailboxId = null, conversationIds = [], subjects = [] } = {}) {
  if (!db) return [];
  const folderColumns = tableColumns(db, 'mail_folders');
  const messageColumns = tableColumns(db, 'messages');
  if (!folderColumns.size || !messageColumns.has('id')) return [];
  const conversations = [...new Set(conversationIds.map((item) => String(item || '').trim()).filter(Boolean))];
  const normalized = [...new Set(subjects.map((item) => normalizeReplySubject(item)).filter(Boolean))];
  const clauses = ['s.deleted_at IS NULL', 's.is_draft = 0', `(${sentFolderPredicate(folderColumns)})`];
  const params = [];
  if (mailboxId != null) {
    clauses.push('s.mailbox_id = ?');
    params.push(mailboxId);
  }
  const match = [];
  if (conversations.length && messageColumns.has('conversation_id')) {
    match.push(`s.conversation_id IN (${conversations.map(() => '?').join(',')})`);
    params.push(...conversations);
  }
  if (normalized.length && messageColumns.has('normalized_subject')) {
    match.push(`lower(s.normalized_subject) IN (${normalized.map(() => '?').join(',')})`);
    params.push(...normalized);
  }
  if (match.length) clauses.push(`(${match.join(' OR ')})`);
  else if (conversations.length || normalized.length) return [];
  const sentAt = messageColumns.has('sent_at') ? 's.sent_at' : 'NULL';
  const conversation = messageColumns.has('conversation_id') ? 's.conversation_id' : '\'\'';
  const normalizedSubject = messageColumns.has('normalized_subject') ? 's.normalized_subject' : '\'\'';
  const display = folderColumns.has('display_name') ? 'f.display_name' : '\'\'';
  const rows = db.prepare(`
    SELECT s.id, s.mailbox_id, s.subject, ${normalizedSubject} AS normalized_subject, s.sender_email,
           s.received_at, ${sentAt} AS sent_at, ${conversation} AS conversation_id,
           f.well_known_name, ${display} AS display_name, s.folder_id
    FROM messages s
    JOIN mail_folders f ON f.id = s.folder_id
    WHERE ${clauses.join(' AND ')}
  `).all(...params);
  const recipientTable = tableColumns(db, 'message_recipients');
  const recipientQuery = recipientTable.has('message_id')
    ? db.prepare('SELECT email_norm FROM message_recipients WHERE message_id = ? AND recipient_type = \'to\'')
    : null;
  return rows.map((row) => ({
    ...row,
    to: recipientQuery ? recipientQuery.all(row.id).map((item) => item.email_norm) : [],
  }));
}

export function annotateReplyGaps(db, mailboxId, messages = []) {
  if (!messages.length) return [];
  const sent = loadSentReplies(db, {
    mailboxId,
    conversationIds: messages.map((message) => message.conversationId || message.conversation_id),
    subjects: messages.map((message) => message.normalized_subject || message.normalizedSubject || message.subject),
  });
  const handled = loadActiveHandledElsewhere(db, mailboxId);
  return messages.map((message) => {
    const marker = markerForMessage(handled, message);
    return {
      ...message,
      handledElsewhere: marker,
      replyGap: needsUnansweredReply({ ...message, handledElsewhere: marker }, sent),
    };
  });
}

export function cancelAnsweredDrafts({ db, drafts, mailboxId = null } = {}) {
  const summary = { cancelled: 0, skipped: 0, reason: ALREADY_REPLIED_REASON };
  if (!db || typeof drafts?.cancel !== 'function' || !tableColumns(db, 'mail_send_drafts').has('draft_id')) return summary;
  const params = [];
  const mailboxClause = mailboxId == null ? '' : ' AND d.mailbox_id = ?';
  if (mailboxId != null) params.push(mailboxId);
  const pending = db.prepare(`
    SELECT d.draft_id, d.mailbox_id, d.message_id, d.status
    FROM mail_send_drafts d
    WHERE d.status = 'needs_approval'${mailboxClause}
  `).all(...params);
  if (!pending.length) return summary;
  const messageColumns = tableColumns(db, 'messages');
  const conversation = messageColumns.has('conversation_id') ? 'm.conversation_id' : '\'\'';
  const sentAt = messageColumns.has('sent_at') ? 'm.sent_at' : 'NULL';
  const normalized = messageColumns.has('normalized_subject') ? 'm.normalized_subject' : '\'\'';
  const folderColumns = tableColumns(db, 'mail_folders');
  const display = folderColumns.has('display_name') ? 'f.display_name' : '\'\'';
  const loadMessage = db.prepare(`
    SELECT m.id, m.mailbox_id, m.subject, ${normalized} AS normalized_subject, m.sender_email,
           m.received_at, ${sentAt} AS sent_at, ${conversation} AS conversation_id,
           f.well_known_name, ${display} AS display_name
    FROM messages m
    LEFT JOIN mail_folders f ON f.id = m.folder_id
    WHERE m.id = ?
  `);
  const linked = pending.map((row) => ({ row, message: row.message_id ? loadMessage.get(row.message_id) : null })).filter((item) => item.message);
  const sent = loadSentReplies(db, {
    mailboxId,
    conversationIds: linked.map((item) => item.message.conversation_id),
    subjects: linked.map((item) => item.message.normalized_subject || item.message.subject),
  });
  const handled = loadActiveHandledElsewhere(db, mailboxId);
  for (const item of linked) {
    const marked = handled.ids.has(item.message.id);
    if (!marked && !hasLaterSentReply(item.message, sent)) {
      summary.skipped += 1;
      continue;
    }
    const updated = drafts.cancel(
      item.row.mailbox_id,
      item.row.draft_id,
      marked ? HANDLED_ELSEWHERE_ACTOR : ALREADY_REPLIED_ACTOR,
      marked ? HANDLED_ELSEWHERE_REASON : ALREADY_REPLIED_REASON,
    );
    if (updated?.status === 'cancelled') summary.cancelled += 1;
    else summary.skipped += 1;
  }
  return summary;
}

export function runReplyDraftPipeline({
  db,
  drafts,
  since = null,
  mailboxId = null,
  dryRun = false,
  queuePath = PENDING_APPROVALS_PATH,
  now = new Date().toISOString(),
  messages = null,
} = {}) {
  if (dryRun !== true && typeof drafts?.create !== 'function') {
    throw new Error('drafts.create is required unless dryRun');
  }
  const loaded = messages || loadInboundMessages(db, { since, mailboxId });
  const sentReplies = db ? loadSentReplies(db, {
    mailboxId,
    conversationIds: loaded.map((message) => message.conversation_id),
    subjects: loaded.map((message) => message.normalized_subject || message.subject),
  }) : [];
  const handledIds = db ? loadActiveHandledElsewhere(db, mailboxId).ids : new Set();
  const summary = {
    version: REPLY_DRAFT_PIPELINE_VERSION,
    dryRun: dryRun === true,
    considered: loaded.length,
    wouldDraft: 0,
    drafted: 0,
    skipped: 0,
    alreadyDrafted: 0,
    byMethod: {},
    byTemplate: {},
    bySkip: {},
    queuePath: dryRun ? null : queuePath,
  };
  const queueRows = [];
  for (const message of loaded) {
    const plan = buildReplyDraftPlan(message, message.classification || null, now);
    summary.byMethod[plan.method] = (summary.byMethod[plan.method] || 0) + (plan.action === 'draft' ? 1 : 0);
    if (plan.action !== 'draft') {
      summary.skipped += 1;
      summary.bySkip[plan.reason] = (summary.bySkip[plan.reason] || 0) + 1;
      continue;
    }
    if (handledIds.has(message.id)) {
      summary.skipped += 1;
      summary.bySkip.handled_elsewhere = (summary.bySkip.handled_elsewhere || 0) + 1;
      continue;
    }
    if (hasLaterSentReply(message, sentReplies)) {
      summary.skipped += 1;
      summary.bySkip.already_replied = (summary.bySkip.already_replied || 0) + 1;
      continue;
    }
    const existing = db ? existingDraftForCopy(db, message) : null;
    if (existing) {
      summary.alreadyDrafted += 1;
      continue;
    }
    summary.wouldDraft += 1;
    summary.byTemplate[plan.template] = (summary.byTemplate[plan.template] || 0) + 1;
    if (dryRun) continue;
    const created = drafts.create(message.mailboxId || message.mailbox_id, DRAFT_SOURCE, plan.request);
    if (created?.draft?.status === 'approved' || created?.draft?.status === 'sent' || created?.draft?.status === 'sending') {
      throw new Error('reply draft pipeline must not approve or send');
    }
    summary.drafted += 1;
    const row = {
      draftId: created.draft.draft_id,
      from: plan.queue.from,
      subject: plan.queue.subject,
      template: plan.queue.template,
      summary: plan.queue.summary,
      created_at: created.draft.created_at || plan.queue.created_at,
    };
    queueRows.push(row);
    if (!created.replay) appendPendingApproval(queuePath, row);
  }
  return { ...summary, queueRows };
}

export function collectDigestFacts(db, { day, mailboxId = null } = {}) {
  const { start, end } = dayBounds(day);
  const params = [start, end];
  const mailbox = mailboxId == null ? '' : ' AND m.mailbox_id = ?';
  if (mailboxId != null) params.push(mailboxId);
  const categories = db.prepare(`
    SELECT COALESCE(pc.work_state, 'unclassified') AS category, COUNT(*) AS count
    FROM messages m
    LEFT JOIN precision_classifications pc ON pc.message_id = m.id
    WHERE m.deleted_at IS NULL AND m.first_seen_at >= ? AND m.first_seen_at < ?${mailbox}
    GROUP BY category
  `).all(...params);
  const countsByCategory = Object.fromEntries(categories.map((row) => [row.category, row.count]));
  const pendingParams = mailboxId == null ? [] : [mailboxId];
  const pending = db.prepare(`
    SELECT draft_id, subject, status, message_id
    FROM mail_send_drafts
    WHERE status = 'needs_approval'${mailboxId == null ? '' : ' AND mailbox_id = ?'}
    ORDER BY created_at
  `).all(...pendingParams);
  const mailParams = [start, end];
  if (mailboxId != null) mailParams.push(mailboxId);
  const mails = db.prepare(`
    SELECT subject, sender_email, body_preview, body_text
    FROM messages m
    WHERE m.deleted_at IS NULL AND m.first_seen_at >= ? AND m.first_seen_at < ?${mailbox}
  `).all(...mailParams);
  const quoteOrTax = [];
  for (const mail of mails) {
    const kind = quoteOrTaxKind(mail);
    if (!kind) continue;
    quoteOrTax.push({ kind, from: mail.sender_email, subject: mail.subject });
  }
  return { countsByCategory, pending, quoteOrTax };
}

export function writeMorningDigest({ db, day, path, mailboxId = null }) {
  const facts = collectDigestFacts(db, { day, mailboxId });
  const markdown = renderMorningDigest({ day, ...facts });
  ensureParent(path);
  writeFileSync(path, markdown, { mode: 0o600 });
  return { path, markdown, ...facts };
}
