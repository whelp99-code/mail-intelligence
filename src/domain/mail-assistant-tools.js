import { createHash } from 'node:crypto';

import { splitMessageHistory } from './precision-classifier.js';

export const MAIL_ASSISTANT_TOOLS_VERSION = 'mail-assistant-tools-v1.2.2';
export const DEFAULT_ASSISTANT_PERSONALITY = Object.freeze({
  role: '업무 담당자',
  tone: '정중하고 간결한 기업 메일',
  opening: '안녕하세요.',
});

const MEETING_INTENT_PATTERN = /(?:회의|미팅|일정\s*(?:협의|조율|확정)|방문|통화|원격\s*지원|화상\s*(?:회의|미팅)|teams|zoom|meet(?:ing)?|schedule|appointment|conference\s+call)/i;
const MEETING_CONFIRMATION_PATTERN = /(?:가능하신|가능한|괜찮으신|확정|진행(?:하겠습니다|하죠|예정)|참석|join|available|works?\s+for\s+you|confirm|scheduled)/i;
const DATE_TIME_PATTERN = /(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}월\s*\d{1,2}일|오늘|내일|모레|금일|월요일|화요일|수요일|목요일|금요일|토요일|일요일|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:[^\n.!?]{0,40}(?:오전|오후|\d{1,2}(?::\d{2})?\s*(?:am|pm)?|gmt[+-]?\d+|utc[+-]?\d+))?/gi;
const TIME_ONLY_PATTERN = /(?:오전|오후)\s*\d{1,2}(?::\d{2})?|\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b/gi;
const SENTENCE_PATTERN = /[^.!?。！？\n]+[.!?。！？]?/gu;
const SUPPORTED_ATTACHMENT_TYPES = Object.freeze({
  txt: ['text/plain'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
});

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bounded(value, max = 4000) {
  return String(value || '').slice(0, max);
}

function sentences(value = '', limit = 6) {
  const result = [];
  const source = cleanMultiline(value);
  let match;
  while ((match = SENTENCE_PATTERN.exec(source))) {
    const text = normalizeSpace(match[0]);
    if (text.length < 3) continue;
    result.push(text);
    if (result.length >= limit) break;
  }
  SENTENCE_PATTERN.lastIndex = 0;
  return result;
}

function currentContent(message = {}) {
  return splitMessageHistory(message.body || message.bodyPreview || '').currentContent;
}

function personalityValue(value, fallback, max = 120) {
  const clean = normalizeSpace(value).slice(0, max);
  return clean || fallback;
}

export function normalizeAssistantPersonality(value = {}) {
  return {
    role: personalityValue(value.role, DEFAULT_ASSISTANT_PERSONALITY.role),
    tone: personalityValue(value.tone, DEFAULT_ASSISTANT_PERSONALITY.tone),
    opening: personalityValue(value.opening, DEFAULT_ASSISTANT_PERSONALITY.opening),
  };
}

export function summarizeMessage(message = {}, classification = {}) {
  const body = currentContent(message);
  const sourceSentences = sentences(body || message.bodyPreview || '', 5);
  const subject = normalizeSpace(message.subject || '');
  const oneLine = bounded(
    sourceSentences[0]
      || subject
      || (message.hasAttachments ? '본문 없이 첨부파일만 있는 메일입니다.' : '요약할 현재 본문이 없습니다.'),
    240,
  );
  const detail = sourceSentences.length
    ? sourceSentences.slice(0, 4)
    : [oneLine];
  return {
    version: MAIL_ASSISTANT_TOOLS_VERSION,
    messageId: String(message.id || ''),
    subject,
    oneLine,
    detail,
    workState: classification.workState || 'review_required',
    nextActor: classification.nextActor || 'unknown',
    priority: classification.priority || 'normal',
    operationalLane: classification.operational?.lane || 'review',
    source: 'local-current-content',
    currentContentOnly: true,
    externalAiUsed: false,
  };
}

export function summarizeThread(messages = [], classifications = new Map()) {
  const ordered = [...messages].sort((left, right) => String(left.receivedAt || left.sentAt || '')
    .localeCompare(String(right.receivedAt || right.sentAt || '')));
  const items = ordered.map((message) => {
    const classification = classifications instanceof Map
      ? classifications.get(message.id)
      : classifications?.[message.id];
    return summarizeMessage(message, classification || {});
  });
  const last = items.at(-1) || null;
  const active = [...items].reverse().find((item) => ['do_now', 'waiting', 'review'].includes(item.operationalLane)) || last;
  const participantSet = new Set();
  for (const message of ordered) {
    if (message.from) participantSet.add(normalizeSpace(message.from));
    for (const recipient of [...(message.toRecipients || []), ...(message.ccRecipients || [])]) {
      const address = recipient?.emailAddress?.address || recipient?.address || recipient;
      if (address) participantSet.add(normalizeSpace(address));
    }
  }
  return {
    version: MAIL_ASSISTANT_TOOLS_VERSION,
    conversationId: String(ordered[0]?.conversationId || ''),
    messageCount: items.length,
    oneLine: active?.oneLine || '요약할 스레드가 없습니다.',
    detailed: items.slice(-8).map((item) => ({
      messageId: item.messageId,
      oneLine: item.oneLine,
      workState: item.workState,
      lane: item.operationalLane,
    })),
    currentLane: active?.operationalLane || 'review',
    nextActor: active?.nextActor || 'unknown',
    priority: active?.priority || 'normal',
    participants: [...participantSet].filter(Boolean).slice(0, 20),
    currentContentOnly: true,
    externalAiUsed: false,
  };
}

export function extractMeetingCandidate(message = {}, { timeZone = 'Asia/Seoul' } = {}) {
  const body = currentContent(message);
  const source = `${message.subject || ''}\n${body}`;
  const detected = MEETING_INTENT_PATTERN.test(source);
  const candidates = [];
  for (const pattern of [DATE_TIME_PATTERN, TIME_ONLY_PATTERN]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const text = normalizeSpace(match[0]);
      if (text && !candidates.includes(text)) candidates.push(text);
      if (candidates.length >= 8) break;
    }
  }
  DATE_TIME_PATTERN.lastIndex = 0;
  TIME_ONLY_PATTERN.lastIndex = 0;
  return {
    version: MAIL_ASSISTANT_TOOLS_VERSION,
    messageId: String(message.id || ''),
    detected,
    meetingIntent: detected,
    candidateTimes: detected ? candidates : [],
    timeZone: normalizeSpace(timeZone) || 'Asia/Seoul',
    availability: 'unknown',
    availabilityReason: 'Calendar free/busy connection is not enabled for this read-only release.',
    confirmationRequested: detected && MEETING_CONFIRMATION_PATTERN.test(source),
    calendarWriteAllowed: false,
    confirmationDraftAllowed: true,
    requiresHumanReview: detected,
    externalAiUsed: false,
  };
}

export function improveDraftText(value = '', personality = DEFAULT_ASSISTANT_PERSONALITY) {
  const normalizedPersonality = normalizeAssistantPersonality(personality);
  const source = cleanMultiline(value);
  if (!source) {
    return {
      text: `${normalizedPersonality.opening}\n\n확인할 내용을 입력해 주세요.\n\n감사합니다.`,
      changed: true,
    };
  }
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  const body = lines
    .map((line) => /[.!?。！？]$/.test(line) ? line : `${line}.`)
    .join('\n');
  const hasOpening = /^(?:안녕하세요|안녕하십니까|hello|dear)\b/i.test(body);
  const hasClosing = /(?:감사합니다|고맙습니다|best regards|regards)[.!?。！？]*$/i.test(body);
  return {
    text: [
      hasOpening ? '' : normalizedPersonality.opening,
      body,
      hasClosing ? '' : '감사합니다.',
    ].filter(Boolean).join('\n\n'),
    changed: true,
  };
}

function replyIntent(classification = {}) {
  if (classification.workState === 'decision_required') {
    return '요청하신 결정 사항을 확인한 뒤 회신드리겠습니다.';
  }
  if (classification.workState === 'action_required') {
    return '요청하신 내용을 확인하고 필요한 조치를 진행하겠습니다.';
  }
  if (classification.workState === 'waiting') {
    return '진행 상태를 확인하고 있어 관련 결과를 기다리겠습니다.';
  }
  if (classification.workState === 'completed') {
    return '처리 완료 내용을 확인했습니다.';
  }
  if (classification.workState === 'reference') {
    return '공유해 주신 내용을 확인했습니다.';
  }
  return '내용을 검토한 뒤 정확히 회신드리겠습니다.';
}

export function generateSafeDraft({
  message = {},
  classification = {},
  mode = 'rapid_reply',
  draftText = '',
  personality = DEFAULT_ASSISTANT_PERSONALITY,
  meetingCandidate = null,
  threadSummary = null,
} = {}) {
  const normalizedPersonality = normalizeAssistantPersonality(personality);
  let body;
  if (mode === 'improve') {
    body = improveDraftText(draftText, normalizedPersonality).text;
  } else if (mode === 'meeting_confirmation') {
    const meeting = meetingCandidate || extractMeetingCandidate(message);
    const candidateText = meeting.candidateTimes?.[0] || '제안해 주신 일정';
    body = [
      normalizedPersonality.opening,
      `${candidateText} 기준으로 일정을 확인했습니다.`,
      '현재 캘린더 가능 여부는 자동 확인되지 않았으므로, 최종 확정 전에 직접 일정을 확인하겠습니다.',
      '감사합니다.',
    ].join('\n\n');
  } else {
    const summary = threadSummary?.oneLine || summarizeMessage(message, classification).oneLine;
    body = [
      normalizedPersonality.opening,
      replyIntent(classification),
      summary ? `확인한 핵심 내용: ${summary}` : '',
      '최종 내용은 발송 전에 직접 검토하겠습니다.',
      '감사합니다.',
    ].filter(Boolean).join('\n\n');
  }
  return {
    version: MAIL_ASSISTANT_TOOLS_VERSION,
    mode,
    to: normalizeSpace(message.from || ''),
    subject: /^re:/i.test(message.subject || '') ? String(message.subject) : `RE: ${message.subject || '(제목 없음)'}`,
    body: bounded(body, 12_000),
    personality: normalizedPersonality,
    generationMode: 'rules-local',
    requiresHumanApproval: true,
    sendAllowed: false,
    calendarWriteAllowed: false,
    crmWriteAllowed: false,
    action: 'copy_only',
    externalAiUsed: false,
  };
}

function attachmentExtension(attachment = {}) {
  const name = String(attachment.name || attachment.fileName || '').toLowerCase();
  const match = name.match(/\.([a-z0-9]+)$/i);
  return match?.[1] || '';
}

function supportedAttachmentType(attachment = {}) {
  const extension = attachmentExtension(attachment);
  const contentType = String(attachment.content_type || attachment.contentType || '').toLowerCase();
  if (Object.hasOwn(SUPPORTED_ATTACHMENT_TYPES, extension)) return extension;
  for (const [type, contentTypes] of Object.entries(SUPPORTED_ATTACHMENT_TYPES)) {
    if (contentTypes.includes(contentType)) return type;
  }
  return '';
}

export function attachmentSummaryCandidate(attachment = {}, { extractedText = '' } = {}) {
  const type = supportedAttachmentType(attachment);
  const cleanText = cleanMultiline(extractedText);
  const supported = Boolean(type);
  const metadata = {
    id: String(attachment.graph_attachment_id || attachment.graphAttachmentId || attachment.id || ''),
    name: String(attachment.name || attachment.fileName || ''),
    contentType: String(attachment.content_type || attachment.contentType || ''),
    size: Number(attachment.size || 0),
    isInline: Boolean(attachment.is_inline || attachment.isInline),
    type,
  };
  if (!supported) {
    return {
      version: MAIL_ASSISTANT_TOOLS_VERSION,
      metadata,
      supported: false,
      contentAvailable: false,
      summaryStatus: 'unsupported',
      summary: 'v1.2.2에서 지원하는 첨부 형식은 PDF, DOCX, TXT입니다.',
      requiresReview: true,
      affectsClassification: false,
      externalAiUsed: false,
    };
  }
  if (!cleanText) {
    return {
      version: MAIL_ASSISTANT_TOOLS_VERSION,
      metadata,
      supported: true,
      contentAvailable: false,
      summaryStatus: 'metadata_only',
      summary: `${metadata.name || '첨부파일'} · ${type.toUpperCase()} · ${metadata.size || 0} bytes. 현재 동기화에는 첨부 원문이 없어 내용 요약을 생성하지 않았습니다.`,
      requiresReview: true,
      affectsClassification: false,
      nextAction: 'Outlook에서 원문을 확인하거나 승인된 텍스트 추출 결과를 제공하세요.',
      externalAiUsed: false,
    };
  }
  const summarySentences = sentences(cleanText, 5);
  return {
    version: MAIL_ASSISTANT_TOOLS_VERSION,
    metadata,
    supported: true,
    contentAvailable: true,
    summaryStatus: 'summarized_from_provided_text',
    summary: summarySentences[0] || normalizeSpace(cleanText).slice(0, 240),
    details: summarySentences,
    sourceHash: createHash('sha256').update(cleanText).digest('hex'),
    extractedTextLength: cleanText.length,
    requiresReview: true,
    affectsClassification: false,
    externalAiUsed: false,
  };
}

export function attachmentSummaryCandidates(attachments = []) {
  return attachments.map((attachment) => attachmentSummaryCandidate(attachment));
}

export const mailAssistantToolInternals = {
  MEETING_INTENT_PATTERN,
  DATE_TIME_PATTERN,
  SUPPORTED_ATTACHMENT_TYPES,
  currentContent,
  sentences,
};
