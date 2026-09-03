import {
  attachmentSummaryCandidate,
  attachmentSummaryCandidates,
  extractMeetingCandidate,
  generateSafeDraft,
  normalizeAssistantPersonality,
  summarizeMessage,
  summarizeThread,
} from '../domain/mail-assistant-tools.js';
import { splitMessageHistory } from '../domain/precision-classifier.js';

const PERSONALITY_METADATA_PREFIX = 'assistant_personality_v1:';

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function boundedText(value = '', max = 40_000) {
  return String(value || '').slice(0, max);
}

export class MailAssistantService {
  constructor({ store, precision }) {
    if (!store) throw new Error('store is required.');
    if (!precision) throw new Error('precision service is required.');
    this.store = store;
    this.precision = precision;
  }

  ensureMailbox(mailboxUser = '') {
    const key = mailboxKey(mailboxUser);
    return this.store.ensureMailbox({
      key,
      address: mailboxUser,
      graphUser: mailboxUser,
    });
  }

  messageContext(mailboxUser = '', messageId) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const message = this.store.getMessage(mailbox.id, String(messageId || ''));
    if (!message) throw new Error('Stored message was not found.');
    const precisionResult = this.precision.getClassification(mailboxUser, message.id);
    return {
      mailbox,
      message,
      classification: precisionResult.classification,
      correction: precisionResult.correction,
      events: precisionResult.events,
    };
  }

  operationalSummary(mailboxUser = '') {
    const summary = this.precision.summary(mailboxUser);
    return {
      operational: summary.calculated?.operational || summary.operational || null,
      reviewRequired: summary.reviewRequired,
      total: summary.total,
      calculated: summary.calculated,
    };
  }

  summary(mailboxUser = '', messageId) {
    const context = this.messageContext(mailboxUser, messageId);
    return {
      ...summarizeMessage(context.message, context.classification),
      operational: context.classification.operational,
    };
  }

  threadSummary(mailboxUser = '', messageId, { limit = 100 } = {}) {
    const context = this.messageContext(mailboxUser, messageId);
    const messages = this.store.getThreadMessages(context.mailbox.id, context.message.id, { limit });
    const classifications = new Map();
    for (const message of messages) {
      const current = this.precision.getClassification(mailboxUser, message.id).classification;
      classifications.set(message.id, current);
    }
    return summarizeThread(messages, classifications);
  }

  meetingCandidate(mailboxUser = '', messageId, { timeZone = 'Asia/Seoul' } = {}) {
    const context = this.messageContext(mailboxUser, messageId);
    return extractMeetingCandidate(context.message, { timeZone });
  }

  attachments(mailboxUser = '', messageId) {
    const context = this.messageContext(mailboxUser, messageId);
    const attachments = this.store.getAttachmentsForMessage(context.mailbox.id, context.message.id);
    return {
      messageId: context.message.id,
      attachments,
      summaries: attachmentSummaryCandidates(attachments),
    };
  }

  attachmentSummary(mailboxUser = '', messageId, attachmentId, { extractedText = '' } = {}) {
    const context = this.messageContext(mailboxUser, messageId);
    const attachments = this.store.getAttachmentsForMessage(context.mailbox.id, context.message.id);
    const attachment = attachments.find((item) => (
      String(item.graphAttachmentId) === String(attachmentId)
      || String(item.databaseId) === String(attachmentId)
    ));
    if (!attachment) throw new Error('Stored attachment metadata was not found.');
    return attachmentSummaryCandidate(attachment, {
      extractedText: boundedText(extractedText, 200_000),
    });
  }

  personality(mailboxUser = '') {
    const mailbox = this.ensureMailbox(mailboxUser);
    const key = `${PERSONALITY_METADATA_PREFIX}${mailbox.id}`;
    return normalizeAssistantPersonality(this.store.getMetadata(key, {}));
  }

  savePersonality(mailboxUser = '', value = {}) {
    const mailbox = this.ensureMailbox(mailboxUser);
    const key = `${PERSONALITY_METADATA_PREFIX}${mailbox.id}`;
    const personality = normalizeAssistantPersonality(value);
    this.store.setMetadata(key, personality);
    this.store.audit('assistant.personality.updated', {
      entityType: 'mailbox',
      entityId: mailbox.id,
      payload: { fields: Object.keys(personality) },
    });
    return personality;
  }

  draft(mailboxUser = '', messageId, options = {}) {
    const context = this.messageContext(mailboxUser, messageId);
    const personality = this.personality(mailboxUser);
    const meetingCandidate = options.mode === 'meeting_confirmation'
      ? this.meetingCandidate(mailboxUser, messageId, options)
      : null;
    const threadSummary = options.mode === 'rapid_reply'
      ? this.threadSummary(mailboxUser, messageId)
      : null;
    const draft = generateSafeDraft({
      message: context.message,
      classification: context.classification,
      mode: options.mode || 'rapid_reply',
      draftText: boundedText(options.draftText, 12_000),
      personality,
      meetingCandidate,
      threadSummary,
    });
    this.store.audit('assistant.draft.generated', {
      entityType: 'message',
      entityId: context.message.id,
      payload: {
        mode: draft.mode,
        sendAllowed: false,
        calendarWriteAllowed: false,
        crmWriteAllowed: false,
      },
    });
    return draft;
  }

  confirmClassification(mailboxUser = '', messageId, { note = '' } = {}) {
    const context = this.messageContext(mailboxUser, messageId);
    const result = this.precision.correct(mailboxUser, messageId, {
      workState: context.classification.workState,
      nextActor: context.classification.nextActor,
      priority: context.classification.priority,
      reasonCode: 'user_confirmed',
      note: boundedText(note || '사용자가 현재 분류를 확인했습니다.', 500),
    });
    this.store.audit('assistant.classification.confirmed', {
      entityType: 'message',
      entityId: context.message.id,
      payload: {
        workState: result.classification.workState,
        nextActor: result.classification.nextActor,
        priority: result.classification.priority,
      },
    });
    return result;
  }

  adjudicationCandidate(mailboxUser = '', messageId) {
    const context = this.messageContext(mailboxUser, messageId);
    const operational = context.classification.operational;
    return {
      eligible: Boolean(operational?.requiresHumanReview),
      message: {
        id: context.message.id,
        subject: context.message.subject,
        currentContent: splitMessageHistory(
          context.message.body || context.message.bodyPreview || '',
        ).currentContent,
        direction: context.message.isOutgoing ? 'outgoing' : 'incoming',
        folder: context.message.folderWellKnownName || context.message.folderName || '',
        receivedAt: context.message.receivedAt,
        attachments: this.store.getAttachmentsForMessage(context.mailbox.id, context.message.id)
          .map((item) => ({ name: item.name, contentType: item.contentType, size: item.size })),
      },
      rules: {
        workState: context.classification.workState,
        nextActor: context.classification.nextActor,
        priority: context.classification.priority,
        lane: operational?.lane || 'review',
      },
      safety: {
        currentContentOnly: true,
        sendAllowed: false,
        calendarWriteAllowed: false,
        crmWriteAllowed: false,
      },
    };
  }
}

export const mailAssistantInternals = {
  PERSONALITY_METADATA_PREFIX,
  mailboxKey,
};
