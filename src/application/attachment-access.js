import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export const ATTACHMENT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_ATTACHMENT_CONTENT_TYPES = Object.freeze(new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]));

const ALLOWED_EXTENSIONS = Object.freeze(new Set([
  '.pdf', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.docx', '.xlsx', '.pptx',
]));

export class AttachmentAccessError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AttachmentAccessError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeName(value = '') {
  return basename(String(value || 'attachment').replace(/[\0\r\n]/g, '')).slice(0, 180) || 'attachment';
}

export function attachmentIsAllowed(attachment = {}) {
  const contentType = String(attachment.contentType || attachment.content_type || '').toLowerCase();
  const extension = extname(String(attachment.name || '')).toLowerCase();
  const size = Number(attachment.size || attachment.size_bytes || 0);
  if (size > ATTACHMENT_DOWNLOAD_MAX_BYTES) return false;
  if (contentType && ALLOWED_ATTACHMENT_CONTENT_TYPES.has(contentType)) return true;
  return ALLOWED_EXTENSIONS.has(extension);
}

export function publicAttachmentMetadata(attachment = {}) {
  return {
    id: String(attachment.graphAttachmentId || attachment.graph_id || attachment.databaseId || ''),
    databaseId: attachment.databaseId ?? null,
    name: String(attachment.name || ''),
    contentType: String(attachment.contentType || ''),
    size: Number(attachment.size || 0),
    isInline: Boolean(attachment.isInline),
    downloadAllowed: attachmentIsAllowed(attachment),
  };
}

function decodeStoredBytes(attachment = {}) {
  const source = attachment.source || {};
  const raw = source.contentBytes || source.content || attachment.contentBytes;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
}

export async function resolveAttachmentBytes({
  attachment,
  downloadFromGraph,
} = {}) {
  if (!attachment) {
    throw new AttachmentAccessError('ATTACHMENT_NOT_FOUND', 'Stored attachment metadata was not found.', 404);
  }
  if (!attachmentIsAllowed(attachment)) {
    throw new AttachmentAccessError(
      'ATTACHMENT_TYPE_NOT_ALLOWED',
      'Attachment type or size is not allowed for operator download.',
      415,
    );
  }
  const stored = decodeStoredBytes(attachment);
  if (stored) {
    if (stored.length > ATTACHMENT_DOWNLOAD_MAX_BYTES) {
      throw new AttachmentAccessError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the operator download limit.', 413);
    }
    return stored;
  }
  if (typeof downloadFromGraph !== 'function') {
    throw new AttachmentAccessError(
      'ATTACHMENT_CONTENT_UNAVAILABLE',
      'Attachment bytes are not cached and Graph download is unavailable.',
      404,
    );
  }
  const bytes = Buffer.from(await downloadFromGraph(attachment));
  if (bytes.length > ATTACHMENT_DOWNLOAD_MAX_BYTES) {
    throw new AttachmentAccessError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the operator download limit.', 413);
  }
  return bytes;
}

export async function saveOperatorDownload({
  directory,
  messageId,
  attachment,
  bytes,
} = {}) {
  const root = resolve(String(directory || ''));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const safeMessage = String(messageId || 'message').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const safeName = normalizeName(attachment?.name || 'attachment').replace(/[^A-Za-z0-9._-]+/g, '_');
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const fileName = `${safeMessage}-${digest}-${safeName}`;
  const targetPath = join(root, fileName);
  await writeFile(targetPath, bytes, { mode: 0o600, flag: 'wx' });
  return {
    saved: true,
    relativePath: `operator-downloads/${fileName}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    name: attachment?.name || safeName,
    contentType: attachment?.contentType || 'application/octet-stream',
  };
}

export function findMessageAttachment(attachments = [], attachmentId) {
  const wanted = String(attachmentId || '').trim();
  if (!wanted) return null;
  return attachments.find((item) => (
    String(item.graphAttachmentId || '') === wanted
    || String(item.databaseId || '') === wanted
    || String(item.graph_id || '') === wanted
  )) || null;
}
