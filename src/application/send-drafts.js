import { createHash, randomUUID } from 'node:crypto';

export const SEND_DRAFT_ACTION_TYPE = 'mail.send';
export const SEND_DRAFT_DESTINATION = 'microsoft-graph';

const PUBLIC_STATUS = Object.freeze({
  'pending-approval': 'needs_approval',
  approved: 'approved',
  executing: 'sending',
  completed: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
  disabled: 'disabled',
});

export class SendDraftError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'SendDraftError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const single = String(value || '').trim();
  return single ? [single] : [];
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function boundedText(value, max) {
  return String(value || '').slice(0, max);
}

function digestPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function normalizeSendDraftInput(input = {}, { source = 'human' } = {}) {
  const to = asList(input.to);
  const cc = asList(input.cc);
  const bcc = asList(input.bcc);
  if (!to.length) {
    throw new SendDraftError('DRAFT_RECIPIENT_REQUIRED', 'to is required.');
  }
  for (const address of [...to, ...cc, ...bcc]) {
    if (!validEmail(address)) {
      throw new SendDraftError('DRAFT_RECIPIENT_INVALID', `Recipient is invalid: ${address}`);
    }
  }
  const subject = boundedText(input.subject, 500);
  const body = boundedText(input.body, 20_000);
  if (!subject) throw new SendDraftError('DRAFT_SUBJECT_REQUIRED', 'subject is required.');
  if (!body) throw new SendDraftError('DRAFT_BODY_REQUIRED', 'body is required.');
  const contentType = String(input.contentType || 'text').toLowerCase() === 'html' ? 'html' : 'text';
  const attachmentRefs = (Array.isArray(input.attachmentRefs) ? input.attachmentRefs : [])
    .slice(0, 10)
    .map((item, index) => ({
      messageId: boundedText(item?.messageId || '', 500),
      attachmentId: boundedText(item?.attachmentId || '', 500),
      name: boundedText(item?.name || '', 200),
      ordinal: index,
    }))
    .filter((item) => item.messageId && item.attachmentId);
  const notes = boundedText(input.notes || input.operatorNote || '', 2_000);
  const replyToMessageId = boundedText(input.replyToMessageId || '', 500);
  const payload = {
    to,
    cc,
    bcc,
    subject,
    body,
    contentType,
    replyToMessageId,
    attachmentRefs,
    notes,
    source: source === 'grok-bot' ? 'grok-bot' : 'human',
  };
  return {
    payload,
    idempotencyKey: boundedText(input.idempotencyKey || `send-draft:${randomUUID()}`, 200),
  };
}

export function publicSendDraft(row) {
  if (!row) return null;
  const payload = row.payload || {};
  return {
    id: String(row.id),
    source: payload.source || 'human',
    status: PUBLIC_STATUS[row.status] || row.status,
    to: payload.to || [],
    cc: payload.cc || [],
    bcc: payload.bcc || [],
    subject: payload.subject || '',
    bodyPreview: boundedText(payload.body || '', 240),
    replyToMessageId: payload.replyToMessageId || '',
    attachmentRefs: payload.attachmentRefs || [],
    notes: payload.notes || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    receipt: row.receipt || null,
    lastError: row.lastErrorCode ? {
      code: row.lastErrorCode,
      message: row.lastErrorMessage,
    } : null,
    approvalRequired: row.status === 'pending-approval',
  };
}

export class SendDraftService {
  constructor({ store, submitApprovedMail, resolveAttachmentBytes } = {}) {
    if (!store) throw new Error('store is required.');
    this.store = store;
    this.submitApprovedMail = submitApprovedMail;
    this.resolveAttachmentBytes = resolveAttachmentBytes;
  }

  create(input = {}, { source = 'human' } = {}) {
    const normalized = normalizeSendDraftInput(input, { source });
    const existing = this.store.getOutboxItemByKey(normalized.idempotencyKey);
    if (existing) return publicSendDraft(existing);
    const created = this.store.createOutboxItem({
      idempotencyKey: normalized.idempotencyKey,
      actionType: SEND_DRAFT_ACTION_TYPE,
      destination: SEND_DRAFT_DESTINATION,
      payload: {
        ...normalized.payload,
        payloadDigest: digestPayload(normalized.payload),
      },
      status: 'pending-approval',
    });
    return publicSendDraft(created);
  }

  get(id) {
    const row = this.store.getOutboxItem(id);
    if (!row || row.actionType !== SEND_DRAFT_ACTION_TYPE) {
      throw new SendDraftError('SEND_DRAFT_NOT_FOUND', 'Send draft was not found.', 404);
    }
    return publicSendDraft(row);
  }

  list({ limit = 25 } = {}) {
    return this.store.listOutboxItems({
      actionType: SEND_DRAFT_ACTION_TYPE,
      limit,
    }).map(publicSendDraft);
  }

  cancel(id) {
    const row = this.store.getOutboxItem(id);
    if (!row || row.actionType !== SEND_DRAFT_ACTION_TYPE) {
      throw new SendDraftError('SEND_DRAFT_NOT_FOUND', 'Send draft was not found.', 404);
    }
    if (row.status === 'completed') {
      throw new SendDraftError('SEND_DRAFT_ALREADY_SENT', 'Send draft was already sent.', 409);
    }
    if (row.status === 'cancelled') return publicSendDraft(row);
    if (!['pending-approval', 'failed'].includes(row.status)) {
      throw new SendDraftError('SEND_DRAFT_NOT_CANCELLABLE', 'Send draft cannot be cancelled in its current state.', 409);
    }
    return publicSendDraft(this.store.updateOutboxItem(row.id, { status: 'cancelled' }));
  }

  async approve(id, {
    accessToken,
    mailboxUser = '',
    approvalId = '',
  } = {}) {
    const row = this.store.getOutboxItem(id);
    if (!row || row.actionType !== SEND_DRAFT_ACTION_TYPE) {
      throw new SendDraftError('SEND_DRAFT_NOT_FOUND', 'Send draft was not found.', 404);
    }
    if (row.status === 'completed' && row.receipt) return publicSendDraft(row);
    if (row.status !== 'pending-approval' && row.status !== 'failed') {
      throw new SendDraftError('SEND_DRAFT_NOT_APPROVABLE', 'Send draft is not waiting for human approval.', 409);
    }
    if (typeof this.submitApprovedMail !== 'function') {
      throw new SendDraftError('GRAPH_SEND_UNAVAILABLE', 'Approved Graph send adapter is not configured.', 503);
    }

    let resolvedAttachments = [];
    if ((row.payload.attachmentRefs || []).length) {
      if (typeof this.resolveAttachmentBytes !== 'function') {
        throw new SendDraftError(
          'ATTACHMENT_CONTENT_UNAVAILABLE',
          'Draft attachment references cannot be resolved before send.',
          409,
        );
      }
      resolvedAttachments = [];
      for (const ref of row.payload.attachmentRefs) {
        const resolved = await this.resolveAttachmentBytes(ref);
        resolvedAttachments.push({
          name: resolved.name || ref.name,
          contentType: resolved.contentType,
          contentBytes: resolved.bytes.toString('base64'),
        });
      }
    }

    this.store.updateOutboxItem(row.id, {
      status: 'executing',
      approvalId: String(approvalId || `human:${new Date().toISOString()}`),
    });

    try {
      const receipt = await this.submitApprovedMail({
        accessToken,
        mailboxUser,
        draft: {
          ...row.payload,
          resolvedAttachments,
        },
      });
      return publicSendDraft(this.store.updateOutboxItem(row.id, {
        status: 'completed',
        receipt,
        lastErrorCode: '',
        lastErrorMessage: '',
      }));
    } catch (error) {
      const failed = this.store.updateOutboxItem(row.id, {
        status: 'failed',
        lastErrorCode: error?.code || 'GRAPH_SEND_FAILED',
        lastErrorMessage: error instanceof Error ? error.message : 'Approved Graph send failed.',
      });
      const wrapped = new SendDraftError(
        error?.code || 'GRAPH_SEND_FAILED',
        error instanceof Error ? error.message : 'Approved Graph send failed.',
        error?.statusCode || 502,
      );
      wrapped.draft = publicSendDraft(failed);
      throw wrapped;
    }
  }
}
