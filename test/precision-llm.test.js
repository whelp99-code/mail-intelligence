import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyPrecisionBatch } from '../src/application/llm-precision.js';
import {
  mergeLlmClassification,
  parsePrecisionLlmResponse,
} from '../src/domain/precision-llm.js';
import { classifyMessage } from '../src/domain/precision-classifier.js';

const greeting = {
  id: 'greet-1',
  subject: '한가위 인사',
  from: 'friend@example.com',
  body: '즐거운 한가위 보내시고 건강하세요.',
  bodyPreview: '즐거운 한가위 보내시고 건강하세요.',
  receivedAt: '2026-09-27T00:00:00.000Z',
};

test('LLM precision output is accepted only when evidence is an exact source span', () => {
  const raw = JSON.stringify({
    messages: [{
      id: 'greet-1',
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
      confidence: 0.9,
      evidence: '즐거운 한가위 보내시고',
      rationale: '인사 메일이다',
    }],
  });
  const parsed = parsePrecisionLlmResponse(raw, [greeting]);
  assert.equal(parsed.rejected.length, 0);
  assert.equal(parsed.accepted[0].workState, 'reference');
  assert.equal(parsed.accepted[0].evidence.exactText.includes('즐거운 한가위'), true);

  const missing = parsePrecisionLlmResponse(JSON.stringify({
    messages: [{
      id: 'greet-1',
      workState: 'action_required',
      nextActor: 'me',
      priority: 'critical',
      confidence: 0.9,
      evidence: '이 문장은 메일에 없다',
      rationale: '없는 근거',
    }],
  }), [greeting]);
  assert.equal(missing.accepted.length, 0);
  assert.equal(missing.rejected[0].code, 'LLM_EVIDENCE_REJECTED');
});

test('an invalid enum does not become a stored classification', () => {
  const parsed = parsePrecisionLlmResponse(JSON.stringify({
    messages: [{
      id: 'greet-1',
      workState: 'urgent',
      nextActor: 'me',
      priority: 'high',
      confidence: 0.8,
      evidence: '즐거운 한가위 보내시고',
      rationale: '잘못된 상태',
    }],
  }), [greeting]);
  assert.equal(parsed.accepted.length, 0);
  assert.equal(parsed.rejected[0].code, 'LLM_ENUM_INVALID');
});

test('accepted LLM fields replace the rules judgment and keep the provider identity', () => {
  const rules = classifyMessage(greeting, { source: 'rules', provider: 'rules' });
  const merged = mergeLlmClassification(rules, {
    workState: 'reference',
    nextActor: 'none',
    priority: 'low',
    confidence: 0.91,
    evidence: {
      sourceField: 'body',
      sourceMessageId: 'greet-1',
      startOffset: 0,
      endOffset: 8,
      exactText: '즐거운 한가위',
      text: '즐거운 한가위',
      rule: 'llm-classification',
    },
    legacyStatus: 'reference',
  }, {
    provider: 'xai-grok-oauth',
    model: 'grok-4.6',
    promptVersion: 'precision-llm-v1',
    analyzedAt: '2026-09-28T01:00:00.000Z',
  });
  assert.equal(merged.source, 'ai');
  assert.equal(merged.provider, 'xai-grok-oauth');
  assert.equal(merged.model, 'grok-4.6');
  assert.equal(merged.workState, 'reference');
  assert.equal(merged.priority, 'low');
  assert.equal(merged.reviewReasons.includes('llm-classification'), true);
});

test('batch classification records provider failure without inventing a success', async () => {
  const result = await classifyPrecisionBatch({
    messages: [greeting],
    provider: 'xai-grok-oauth',
    model: 'grok-4.6',
    runProvider: async () => {
      const error = new Error('provider unavailable');
      error.code = 'OAUTH_PROVIDER_EXEC_FAILED';
      throw error;
    },
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].code, 'OAUTH_PROVIDER_EXEC_FAILED');
  assert.equal(result.provider, 'xai-grok-oauth');
});
