function text(value, max = 1_000_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function htmlToText(value = '') {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|table|blockquote)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function emailAddress(value) {
  const email = value?.emailAddress || value || {};
  return {
    email: text(email.address, 320),
    name: text(email.name, 500),
  };
}

function recipientList(values, type) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value, ordinal) => ({ ...emailAddress(value), type, ordinal }))
    .filter((recipient) => recipient.email);
}

function bodyText(message) {
  const body = message?.body || {};
  const content = text(body.content, 2_000_000) || text(message?.bodyPreview, 200_000);
  return String(body.contentType || '').toLowerCase() === 'html' ? htmlToText(content) : content;
}

function isPromotional(message) {
  const sender = emailAddress(message?.from || message?.sender).email;
  const value = `${message?.subject || ''} ${sender} ${message?.bodyPreview || ''}`.toLowerCase();
  return /unsubscribe|수신거부|광고|newsletter|promotion|마케팅|이벤트|쿠폰|할인|webinar|세미나|광고성/.test(value);
}

export function normalizeGraphAttachment(attachment = {}) {
  return {
    graphId: text(attachment.id, 1000),
    type: text(attachment['@odata.type'], 200),
    name: text(attachment.name, 1000),
    contentType: text(attachment.contentType, 500),
    size: Math.max(Number(attachment.size || 0), 0),
    isInline: Boolean(attachment.isInline),
    contentId: text(attachment.contentId, 1000),
    modifiedAt: text(attachment.lastModifiedDateTime, 100),
    source: {
      id: attachment.id || '',
      '@odata.type': attachment['@odata.type'] || '',
      name: attachment.name || '',
      contentType: attachment.contentType || '',
      size: Number(attachment.size || 0),
      isInline: Boolean(attachment.isInline),
      contentId: attachment.contentId || '',
      lastModifiedDateTime: attachment.lastModifiedDateTime || '',
    },
  };
}

export function normalizeGraphMessage(message = {}) {
  const graphId = text(message.id, 2000);
  if (!graphId) throw new Error('Microsoft Graph message id is required.');
  if (message['@removed']) {
    return {
      kind: 'removed',
      graphId,
      reason: text(message['@removed']?.reason, 120) || 'changed',
      source: {
        id: message.id,
        '@removed': message['@removed'],
      },
    };
  }

  const sender = emailAddress(message.from || message.sender);
  const recipients = [
    ...recipientList(message.toRecipients, 'to'),
    ...recipientList(message.ccRecipients, 'cc'),
    ...recipientList(message.bccRecipients, 'bcc'),
    ...recipientList(message.replyTo, 'replyTo'),
  ];
  const attachments = Array.isArray(message.attachments)
    ? message.attachments.map(normalizeGraphAttachment)
    : null;
  const categories = Array.isArray(message.categories)
    ? [...new Set(message.categories.map((value) => text(value, 300)).filter(Boolean))]
    : [];
  const source = {
    id: message.id,
    changeKey: message.changeKey || '',
    conversationId: message.conversationId || '',
    internetMessageId: message.internetMessageId || '',
    subject: message.subject || '',
    from: message.from || message.sender || null,
    toRecipients: message.toRecipients || [],
    ccRecipients: message.ccRecipients || [],
    bccRecipients: message.bccRecipients || [],
    replyTo: message.replyTo || [],
    receivedDateTime: message.receivedDateTime || '',
    sentDateTime: message.sentDateTime || '',
    createdDateTime: message.createdDateTime || '',
    lastModifiedDateTime: message.lastModifiedDateTime || '',
    importance: message.importance || 'normal',
    inferenceClassification: message.inferenceClassification || '',
    flag: message.flag || null,
    categories,
    isRead: Boolean(message.isRead),
    isDraft: Boolean(message.isDraft),
    hasAttachments: Boolean(message.hasAttachments),
    bodyPreview: message.bodyPreview || '',
    body: message.body || null,
    webLink: message.webLink || '',
    parentFolderId: message.parentFolderId || '',
  };
  if (attachments) source.attachments = attachments.map((item) => item.source);

  return {
    kind: 'upsert',
    graphId,
    changeKey: text(message.changeKey, 2000),
    conversationId: text(message.conversationId, 2000),
    internetMessageId: text(message.internetMessageId, 2000),
    subject: text(message.subject, 20_000),
    sender,
    recipients,
    receivedAt: text(message.receivedDateTime, 100),
    sentAt: text(message.sentDateTime, 100),
    createdAt: text(message.createdDateTime, 100),
    modifiedAt: text(message.lastModifiedDateTime, 100),
    importance: text(message.importance, 40) || 'normal',
    inferenceClassification: text(message.inferenceClassification, 80),
    flagStatus: text(message.flag?.flagStatus, 80),
    categories,
    isRead: Boolean(message.isRead),
    isDraft: Boolean(message.isDraft),
    hasAttachments: Boolean(message.hasAttachments),
    isPromotional: isPromotional(message),
    bodyPreview: text(message.bodyPreview, 200_000),
    bodyText: bodyText(message),
    webLink: text(message.webLink, 10_000),
    parentFolderId: text(message.parentFolderId, 2000),
    attachments,
    source,
  };
}

export function normalizeLegacyCachedMessage(message = {}) {
  const sender = typeof message.from === 'string'
    ? { email: text(message.from, 320), name: text(message.fromName, 500) }
    : emailAddress(message.from);
  const ccRecipients = Array.isArray(message.cc)
    ? message.cc.map((address) => ({ emailAddress: { address } }))
    : message.ccRecipients || [];
  return normalizeGraphMessage({
    id: message.id,
    changeKey: message.changeKey || '',
    conversationId: message.conversationId || `legacy:${message.id}`,
    internetMessageId: message.internetMessageId || '',
    subject: message.subject || '',
    from: { emailAddress: { address: sender.email, name: sender.name } },
    ccRecipients,
    receivedDateTime: message.receivedAt || '',
    sentDateTime: message.sentAt || '',
    importance: message.importance || 'normal',
    isRead: Boolean(message.isRead),
    isDraft: Boolean(message.isDraft),
    hasAttachments: Boolean(message.hasAttachments),
    bodyPreview: message.bodyPreview || '',
    body: { contentType: 'text', content: message.body || message.bodyPreview || '' },
    webLink: message.webLink || '',
    parentFolderId: message.parentFolderId || 'inbox',
    categories: message.categories || [],
  });
}

export const mailNormalizerInternals = {
  bodyText,
  emailAddress,
  htmlToText,
  isPromotional,
  recipientList,
};
