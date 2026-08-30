import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, parseAiResponse } from '../src/ai/response.js';

test('코드 펜스가 포함된 AI JSON 응답도 추출한다', () => {
  const parsed = extractJson('설명\n```json\n{"messages":[]}\n```');
  assert.deepEqual(parsed, { messages: [] });
});

test('AI 응답을 제한된 정규 형태로 검증한다', () => {
  const parsed = parseAiResponse(JSON.stringify({
    messages: [{
      id: 'mail-1',
      status: '긴급',
      summary: ['요약 1', '요약 2'],
      nextActions: [{
        recommendedAction: '오늘 회신',
        priority: 99,
        lane: 'urgent',
        evidence: '오늘까지 요청'
      }, { recommendedAction: '대안' }, { recommendedAction: '제한 밖' }],
      evidenceItems: ['근거'],
      aiRationale: '마감 표현'
    }]
  }));

  assert.equal(parsed.messages[0].status, 'urgent');
  assert.equal(parsed.messages[0].nextActions.length, 2);
  assert.equal(parsed.messages[0].nextActions[0].priority, 6);
});

test('messages 배열이나 message id가 없으면 실패한다', () => {
  assert.throws(() => parseAiResponse('{}'), /messages must be an array/);
  assert.throws(() => parseAiResponse('{"messages":[{}]}'), /id is required/);
});
