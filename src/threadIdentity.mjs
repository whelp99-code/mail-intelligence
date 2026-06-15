/** Thread identity — conversationId, normalized subject, participant overlap. */

export function normalizedSubjectKey(subject = '') {
  return String(subject || '')
    .toLowerCase()
    .replace(/^(re|fw|fwd)\s*:\s*/gi, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/external\s*:/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s*(문의\s*드립니다?|회신\s*부탁|감사합니다?)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function subjectTokens(subject = '') {
  return normalizedSubjectKey(subject)
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

export function subjectSimilarity(a = '', b = '') {
  const ta = new Set(subjectTokens(a));
  const tb = new Set(subjectTokens(b));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap += 1;
  }
  return overlap / Math.max(ta.size, tb.size);
}

export function threadKeyForMessage(message, { mailboxUser = '' } = {}) {
  const aiGroupKey = String(message?.aiGroupKey || '').trim();
  if (aiGroupKey) return `ai:${aiGroupKey}`;

  const conversationId = String(message?.conversationId || '').trim();
  if (conversationId) return `conv:${conversationId}`;

  const subjectKey = normalizedSubjectKey(message?.subject);
  if (subjectKey.length >= 6) return `subj:${subjectKey}`;

  return `msg:${message?.id || 'unknown'}`;
}

export function groupMessagesByThread(messages, options = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const byKey = new Map();

  for (const message of items) {
    let key = threadKeyForMessage(message, options);
    if (key.startsWith('subj:')) {
      const existing = [...byKey.entries()].find(([, group]) =>
        group.some((item) => subjectSimilarity(item.subject, message.subject) >= 0.72)
      );
      if (existing) key = existing[0];
    }
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(message);
  }

  for (const group of byKey.values()) {
    group.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
  }
  return byKey;
}

export function latestMessageInThread(messages) {
  const sorted = [...(messages || [])].sort(
    (a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0)
  );
  return sorted[0] || null;
}

export function threadLabel(messages) {
  const rep = latestMessageInThread(messages);
  if (!rep) return '(제목 없음)';
  const subject = rep.subject || '(제목 없음)';
  if (messages.length <= 1) return subject;
  const participants = [
    ...new Set(messages.map((m) => m.fromName || m.from).filter(Boolean))
  ].slice(0, 4);
  return `${subject} · ${messages.length}통${participants.length ? ` · ${participants.join(', ')}` : ''}`;
}

export function collectUserEmails(mailboxUser = '') {
  const emails = new Set();
  const trimmed = String(mailboxUser || '').trim().toLowerCase();
  if (trimmed && trimmed.includes('@')) emails.add(trimmed);
  return emails;
}

export function isUserAuthoredMessage(message, userEmails = new Set()) {
  if (!message) return false;
  if (message.mailFolder === 'sent' || message.mailFolder === 'sentitems') return true;
  const from = String(message.from || '').toLowerCase();
  return userEmails.has(from);
}

/** True when the user sent a reply after the latest inbound external message. */
export function userRepliedInThread(messages, mailboxUser = '') {
  const userEmails = collectUserEmails(mailboxUser);
  const sent = (messages || []).filter((m) => isUserAuthoredMessage(m, userEmails));
  if (!sent.length) return false;

  const inbound = (messages || []).filter((m) => !isUserAuthoredMessage(m, userEmails));
  if (!inbound.length) return sent.length > 0;

  const latestInbound = latestMessageInThread(inbound);
  const latestSent = latestMessageInThread(sent);
  if (!latestInbound || !latestSent) return false;
  return new Date(latestSent.receivedAt || 0) >= new Date(latestInbound.receivedAt || 0);
}

export function threadLaneFromInsights(messages, insightFor, { mailboxUser = '' } = {}) {
  if (userRepliedInThread(messages, mailboxUser)) return 'waiting';
  const rep = latestMessageInThread(messages);
  if (!rep) return 'active';
  const insight = insightFor(rep.id);
  return insight?.effectiveStatus || insight?.status || 'active';
}
