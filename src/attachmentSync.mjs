import { createHash } from 'node:crypto';

const MAX_MESSAGES_PER_SYNC = 8;
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;

export function hashAttachmentContent(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function fingerprintAttachment({ name = '', size = 0, messageId = '', attachmentId = '' }) {
  return createHash('sha256')
    .update(`${messageId}|${attachmentId}|${name}|${size}`)
    .digest('hex');
}

export function mergeAttachmentsIntoArchive(archive = {}, newEntries = [], options = {}) {
  const dedupeByHash = options.dedupeByHash !== false;
  const entries = Array.isArray(archive.entries) ? [...archive.entries] : [];
  const hashIndex = new Set(
    entries.map((entry) => entry.contentHash).filter(Boolean)
  );
  const idIndex = new Set(entries.map((entry) => entry.id));

  let added = 0;
  let skippedDuplicates = 0;

  for (const entry of newEntries) {
    if (!entry?.id || idIndex.has(entry.id)) continue;
    if (dedupeByHash && entry.contentHash && hashIndex.has(entry.contentHash)) {
      skippedDuplicates += 1;
      continue;
    }
    entries.push(entry);
    idIndex.add(entry.id);
    if (entry.contentHash) hashIndex.add(entry.contentHash);
    added += 1;
  }

  entries.sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));

  return {
    archive: {
      version: archive.version || 1,
      entries,
      lastSyncedAt: new Date().toISOString()
    },
    added,
    skippedDuplicates
  };
}

function inferCategory(name = '') {
  const lower = name.toLowerCase();
  if (/\.(pdf)$/i.test(lower)) return 'document';
  if (/\.(xlsx?|csv)$/i.test(lower)) return 'spreadsheet';
  if (/\.(pptx?)$/i.test(lower)) return 'presentation';
  if (/\.(zip|rar|7z)$/i.test(lower)) return 'archive';
  if (/manual|메뉴얼|매뉴얼|brochure|제안|quote|견적/i.test(lower)) return 'sales';
  return 'other';
}

export function buildAttachmentEntry({ message, attachment, contentHash, accountEmail }) {
  const attachmentId = attachment.id || attachment.attachmentId;
  const name = attachment.name || 'attachment';
  const size = Number(attachment.size || 0);
  const entryId = `${message.id}:${attachmentId}`;

  return {
    id: entryId,
    attachmentId,
    messageId: message.id,
    name,
    size,
    contentType: attachment.contentType || 'application/octet-stream',
    subject: message.subject || '',
    from: message.from || '',
    fromName: message.fromName || '',
    accountEmail: accountEmail || '',
    receivedAt: message.receivedAt || new Date().toISOString(),
    category: inferCategory(name),
    categoryLabel: inferCategory(name),
    hasDownload: Boolean(contentHash),
    contentHash: contentHash || fingerprintAttachment({
      name,
      size,
      messageId: message.id,
      attachmentId
    }),
    source: 'graph',
    syncedAt: new Date().toISOString()
  };
}

export async function fetchGraphAttachmentsForMessage({
  graphBaseUrl,
  mailboxPath,
  messageId,
  accessToken
}) {
  const url = `${graphBaseUrl}${mailboxPath}/messages/${encodeURIComponent(messageId)}/attachments`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Graph attachments failed: ${response.status} ${text}`);
  }
  const payload = await response.json();
  return Array.isArray(payload.value) ? payload.value : [];
}

export async function syncAttachmentsFromMessages({
  messages = [],
  accessToken,
  graphBaseUrl,
  mailboxPath,
  accountEmail,
  archive = {},
  top = MAX_MESSAGES_PER_SYNC
}) {
  const candidates = messages
    .filter((message) => message.hasAttachments)
    .slice(0, top);

  const newEntries = [];
  let scannedMessages = 0;
  let scannedAttachments = 0;

  for (const message of candidates) {
    scannedMessages += 1;
    let attachments = [];
    try {
      attachments = await fetchGraphAttachmentsForMessage({
        graphBaseUrl,
        mailboxPath,
        messageId: message.id,
        accessToken
      });
    } catch {
      continue;
    }

    for (const attachment of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      scannedAttachments += 1;
      const odataType = attachment['@odata.type'] || '';
      if (!odataType.includes('fileAttachment')) continue;

      const size = Number(attachment.size || 0);
      if (size > MAX_CONTENT_BYTES) continue;

      let contentHash = '';
      if (attachment.contentBytes) {
        try {
          const buffer = Buffer.from(attachment.contentBytes, 'base64');
          contentHash = hashAttachmentContent(buffer);
        } catch {
          contentHash = fingerprintAttachment({
            name: attachment.name,
            size,
            messageId: message.id,
            attachmentId: attachment.id
          });
        }
      } else {
        contentHash = fingerprintAttachment({
          name: attachment.name,
          size,
          messageId: message.id,
          attachmentId: attachment.id
        });
      }

      newEntries.push(
        buildAttachmentEntry({
          message,
          attachment,
          contentHash,
          accountEmail
        })
      );
    }
  }

  const merged = mergeAttachmentsIntoArchive(archive, newEntries);
  return {
    ...merged,
    scannedMessages,
    scannedAttachments
  };
}
