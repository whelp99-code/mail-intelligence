import {
  applyPrecisionCorrection,
  classificationFingerprint,
} from './precision-classifier.js';
import { deriveOperationalClassification } from './operational-classification.js';

export const CORRECTION_GENERALIZATION_VERSION = 'correction-generalization-v1';
export const LEARNING_MATCH_THRESHOLD = 4;
export const MAX_GENERALIZED_MESSAGES = 50;

const REPLY_PREFIX = /^(?:re|fw|fwd|회신|전달)\s*:\s*/i;

export function senderKey(message = {}) {
  return String(message.from || message.senderEmail || message.sender || '')
    .replace(/^.*</, '')
    .replace(/>.*$/, '')
    .trim()
    .toLowerCase();
}

export function subjectTokens(subject = '') {
  return String(subject || '')
    .replace(REPLY_PREFIX, '')
    .replace(/\[[^\]]+\]/g, ' ')
    .toLowerCase()
    .replace(/[()[\]{}<>,.;:!?'"`~@#$%^&*_+=|\\/]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^\d+$/, ''))
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

export function templateKey(subject = '') {
  return [...new Set(subjectTokens(subject))].sort().join(' ');
}

export function policyKey(message = {}) {
  const sender = senderKey(message);
  const template = templateKey(message.subject);
  if (!sender) return '';
  if (template) return `${sender}|${template}`;
  const conversationId = String(message.conversationId || '').trim();
  return conversationId ? `${sender}|thread:${conversationId}` : '';
}

export function learningScore(message = {}, policy = {}) {
  const sender = senderKey(message);
  if (!sender || sender !== String(policy.senderEmail || '').toLowerCase()) return 0;
  let score = 2;
  const conversationId = String(message.conversationId || '').trim();
  if (conversationId && conversationId === String(policy.conversationId || '').trim()) score += 3;
  const tokens = new Set(subjectTokens(message.subject));
  for (const token of policy.subjectTokens || []) {
    if (tokens.has(token)) score += 1;
  }
  return score;
}

export function policyMatches(message = {}, policy = {}) {
  if (!policy?.active && policy?.active !== undefined && policy.active !== 1) return false;
  return learningScore(message, policy) >= LEARNING_MATCH_THRESHOLD;
}

export function bestLearningPolicy(message = {}, policies = []) {
  const ranked = policies
    .filter((policy) => policy && policy.active !== 0 && policy.active !== false)
    .map((policy) => ({ policy, score: learningScore(message, policy) }))
    .filter((item) => item.score >= LEARNING_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score
      || String(right.policy.updatedAt || '').localeCompare(String(left.policy.updatedAt || '')));
  return ranked[0]?.policy || null;
}

export function feedbackStatusForOverrides(overrides = {}) {
  const workState = String(overrides.workState || '');
  const priority = String(overrides.priority || '');
  if (workState === 'completed') return 'done';
  if (workState === 'reference') return 'reference';
  if (workState === 'waiting') return 'waiting';
  if (workState === 'action_required' || workState === 'decision_required') {
    return priority === 'critical' || priority === 'high' ? 'urgent' : 'active';
  }
  return '';
}

export function policyFromCorrection(message = {}, correction = {}) {
  const key = policyKey(message);
  if (!key || !correction?.overrides || !Object.keys(correction.overrides).length) return null;
  return {
    policyKey: key,
    senderEmail: senderKey(message),
    conversationId: String(message.conversationId || '').trim(),
    subjectTemplate: templateKey(message.subject),
    subjectTokens: subjectTokens(message.subject),
    overrides: correction.overrides,
    reasonCode: correction.reasonCode || '',
    note: correction.note || '',
    sourceGraphId: String(message.id || ''),
    savedAt: correction.savedAt || new Date().toISOString(),
  };
}

export function applyLearnedPolicy(classification = {}, policy = {}) {
  if (!policy?.overrides || !Object.keys(policy.overrides).length) return classification;
  const applied = applyPrecisionCorrection(classification, {
    overrides: policy.overrides,
    reasonCode: policy.reasonCode || 'learned-correction',
    note: policy.note || '유사 메일 보정',
    savedAt: policy.updatedAt || policy.savedAt || new Date().toISOString(),
  });
  const reviewReasons = [...new Set([
    ...(classification.reviewReasons || []).filter((reason) => !String(reason).startsWith('learned-policy:')),
    `learned-policy:${policy.id || policy.policyKey}`,
    policy.reasonCode ? `learned:${policy.reasonCode}` : 'learned-correction',
  ])].sort();
  const next = {
    ...applied,
    source: 'hybrid',
    provider: classification.provider || 'rules',
    model: classification.model || '',
    promptVersion: classification.promptVersion || '',
    reviewStatus: 'auto',
    correctedAt: null,
    reviewReasons,
    signals: [...new Set([...(classification.signals || []), 'learned_correction'])].sort(),
  };
  next.operational = deriveOperationalClassification(next, {
    eventFrame: {
      events: [],
      conflicts: classification.eventFrame?.conflicts || [],
    },
  });
  next.fingerprint = classificationFingerprint(next);
  return next;
}
