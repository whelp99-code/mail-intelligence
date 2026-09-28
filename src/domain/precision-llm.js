import { createHash } from 'node:crypto';

import { extractJsonObject } from '../ai-contract.js';
import {
  EVIDENCE_NORMALIZATION_VERSION,
  NEXT_ACTORS,
  PRIORITIES,
  WORK_STATES,
  classificationFingerprint,
  splitMessageHistory,
} from './precision-classifier.js';
import { deriveOperationalClassification } from './operational-classification.js';

export const PRECISION_LLM_PROMPT_VERSION = 'precision-llm-v1';

const WORK_STATE_SET = new Set(WORK_STATES);
const NEXT_ACTOR_SET = new Set(NEXT_ACTORS);
const PRIORITY_SET = new Set(PRIORITIES);

function clip(value = '', max = 2200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function currentBody(message = {}) {
  const history = splitMessageHistory(message.body || message.bodyPreview || '');
  return history.currentContent || String(message.bodyPreview || '');
}

export function llmSourceText(message = {}) {
  return {
    subject: String(message.subject || ''),
    body: currentBody(message),
  };
}

export function buildPrecisionLlmPrompt(messages = [], {
  promptVersion = PRECISION_LLM_PROMPT_VERSION,
} = {}) {
  const payload = messages.map((message) => {
    const source = llmSourceText(message);
    return {
      id: String(message.id || ''),
      subject: source.subject,
      from: String(message.from || ''),
      receivedAt: message.receivedAt || '',
      folder: message.folderName || '',
      isDraft: Boolean(message.isDraft || message.isDraftFolder),
      isOutgoing: Boolean(message.isOutgoing),
      body: clip(source.body, 2200),
    };
  });
  return `You are a cautious mail work-state classifier. Return ONLY JSON. No markdown.
Prompt version: ${promptVersion}
Classify the CURRENT text only. Quoted history has already been removed from body.
Do not invent a request that is not in the supplied subject or body.

workState: action_required | waiting | decision_required | completed | reference | review_required
nextActor: me | internal_team | external_party | shared | none | unknown
priority: critical | high | normal | low

Rules:
- A greeting, holiday notice, or newsletter with no personal task is reference / none / low.
- A test, canary, or ignore request is reference / none / low.
- An unsent draft that asks someone to do something is action_required / me / normal. Do not mark it reference.
- A sent message with an explicit request for the other party is waiting / external_party.
- A sent message that fulfills the current request and asks for nothing more is completed / none.
- An inbound message that explicitly asks me to produce or send something is action_required / me.
- Informational support-hour notices are not critical unless the current text describes an active incident I must handle.
- Promotional mail is reference / none / low.
- If the current text is insufficient, use review_required / unknown / normal and lower confidence.
- evidence must be an exact contiguous substring of the supplied subject or body, 8-160 characters. Do not paraphrase.

JSON:
{"messages":[{"id":"same id","workState":"reference","nextActor":"none","priority":"low","confidence":0.8,"evidence":"exact quote","rationale":"one sentence"}]}

Emails:
${JSON.stringify(payload)}`;
}

function collapse(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function locateEvidenceQuote(message = {}, quote = '') {
  const needle = collapse(quote);
  if (needle.length < 8 || needle.length > 160) return null;
  const sources = llmSourceText(message);
  for (const sourceField of ['subject', 'body']) {
    const source = sources[sourceField];
    const exactIndex = source.indexOf(needle);
    if (exactIndex >= 0) {
      return span(source, sourceField, exactIndex, exactIndex + needle.length, message.id);
    }
    const pattern = needle
      .split(' ')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s+');
    const match = source.match(new RegExp(pattern, 'i'));
    if (match && match.index != null) {
      return span(source, sourceField, match.index, match.index + match[0].length, message.id);
    }
  }
  return null;
}

function span(source, sourceField, start, end, messageId) {
  const exactText = source.slice(start, end);
  if (!exactText) return null;
  return {
    field: 'workState',
    sourceField,
    sourceMessageId: String(messageId || ''),
    startOffset: start,
    endOffset: end,
    exactText,
    text: exactText,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    normalizationVersion: EVIDENCE_NORMALIZATION_VERSION,
    start,
    end,
    rule: 'llm-classification',
  };
}

function legacyStatusFor(workState, priority) {
  if (workState === 'completed') return 'done';
  if (workState === 'reference') return 'reference';
  if (workState === 'waiting') return 'waiting';
  if (workState === 'action_required' || workState === 'decision_required') {
    return ['critical', 'high'].includes(priority) ? 'urgent' : 'active';
  }
  return 'active';
}

export function parsePrecisionLlmResponse(raw, messages = []) {
  const byId = new Map(messages.map((message) => [String(message.id || ''), message]));
  let payload;
  try {
    payload = extractJsonObject(raw);
  } catch (error) {
    return {
      accepted: [],
      rejected: messages.map((message) => ({
        messageId: String(message.id || ''),
        code: 'LLM_JSON_INVALID',
        message: error instanceof Error ? error.message : 'LLM JSON was invalid.',
      })),
    };
  }
  const rows = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!rows) {
    return {
      accepted: [],
      rejected: messages.map((message) => ({
        messageId: String(message.id || ''),
        code: 'LLM_SCHEMA_INVALID',
        message: 'LLM response did not contain messages.',
      })),
    };
  }
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const row of rows) {
    const messageId = String(row?.id || '');
    const message = byId.get(messageId);
    if (!message || seen.has(messageId)) {
      rejected.push({ messageId, code: 'LLM_MESSAGE_UNKNOWN', message: 'LLM returned an unexpected message id.' });
      continue;
    }
    seen.add(messageId);
    const workState = String(row.workState || '').trim().toLowerCase();
    const nextActor = String(row.nextActor || '').trim().toLowerCase();
    const priority = String(row.priority || '').trim().toLowerCase();
    const confidence = Number(row.confidence);
    if (!WORK_STATE_SET.has(workState) || !NEXT_ACTOR_SET.has(nextActor) || !PRIORITY_SET.has(priority)) {
      rejected.push({ messageId, code: 'LLM_ENUM_INVALID', message: 'LLM classification used an unknown field value.' });
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      rejected.push({ messageId, code: 'LLM_CONFIDENCE_INVALID', message: 'LLM confidence was not between 0 and 1.' });
      continue;
    }
    const evidence = locateEvidenceQuote(message, row.evidence);
    if (!evidence) {
      rejected.push({ messageId, code: 'LLM_EVIDENCE_REJECTED', message: 'LLM evidence was not an exact span of the source mail.' });
      continue;
    }
    accepted.push({
      messageId,
      workState,
      nextActor: ['completed', 'reference'].includes(workState) ? 'none' : nextActor,
      priority,
      confidence,
      evidence,
      rationale: clip(row.rationale, 400),
      legacyStatus: legacyStatusFor(workState, priority),
    });
  }
  for (const message of messages) {
    const messageId = String(message.id || '');
    if (!seen.has(messageId)) {
      rejected.push({ messageId, code: 'LLM_MESSAGE_OMITTED', message: 'LLM response omitted this message.' });
    }
  }
  return { accepted, rejected };
}

export function mergeLlmClassification(classification = {}, observation = {}, meta = {}) {
  const confidence = Number(observation.confidence);
  const evidence = {
    ...(classification.evidence || {}),
    workState: { ...observation.evidence, field: 'workState' },
    nextActor: { ...observation.evidence, field: 'nextActor' },
    priority: { ...observation.evidence, field: 'priority' },
  };
  const reviewReasons = [...new Set([
    ...(classification.reviewReasons || []).filter((reason) => !String(reason).startsWith('llm-')),
    'llm-classification',
  ])].sort();
  const next = {
    ...classification,
    workState: observation.workState,
    nextActor: observation.nextActor,
    priority: observation.priority,
    evidence,
    confidence: {
      ...(classification.confidence || {}),
      workState: confidence,
      nextActor: confidence,
      priority: confidence,
    },
    reviewReasons,
    reviewStatus: observation.workState === 'review_required' || confidence < 0.55
      ? 'review_required'
      : 'auto',
    source: 'ai',
    provider: meta.provider || 'unknown',
    model: meta.model || '',
    promptVersion: meta.promptVersion || PRECISION_LLM_PROMPT_VERSION,
    analyzedAt: meta.analyzedAt || new Date().toISOString(),
    legacyStatus: observation.legacyStatus || legacyStatusFor(observation.workState, observation.priority),
  };
  next.operational = deriveOperationalClassification(next, {
    eventFrame: classification.eventFrame || { events: [], conflicts: [] },
  });
  next.fingerprint = classificationFingerprint(next);
  return next;
}

export function labelLlmFailure(classification = {}, failure = {}) {
  const code = String(failure.code || 'LLM_FAILED').slice(0, 80);
  const reviewReasons = [...new Set([
    ...(classification.reviewReasons || []).filter((reason) => !String(reason).startsWith('llm-failed:')),
    `llm-failed:${code}`,
  ])].sort();
  const next = {
    ...classification,
    reviewReasons,
    source: classification.source || 'rules',
    provider: classification.provider || 'rules',
    model: classification.model || '',
  };
  next.fingerprint = classificationFingerprint(next);
  return next;
}
