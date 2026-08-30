import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMessages } from '../src/analyzer.js';

function analyze(body, overrides = {}) {
  const message = {
    id: overrides.id || 'message-1',
    subject: overrides.subject || '업무 메일',
    from: overrides.from || 'sender@example.com',
    fromName: overrides.fromName || '보낸 사람',
    receivedAt: overrides.receivedAt || '2026-08-28T01:00:00.000Z',
    importance: overrides.importance || 'normal',
    isRead: false,
    body,
    bodyPreview: body,
    ...overrides,
  };
  return analyzeMessages([message]).messageInsights[0];
}

test('현재의 긴급 재작업 요청은 과거 완료 표현보다 우선한다', () => {
  const insight = analyze('기존 발송은 완료했지만 오늘 중 긴급 재작업 부탁드립니다.');
  assert.equal(insight.status, 'urgent');
  assert.equal(insight.nextActions.length, 1);
  assert.equal(insight.nextActions[0].lane, 'urgent');
});

test('회신이 필요 없는 뉴스레터는 reference이며 회신 초안을 만들지 않는다', () => {
  const insight = analyze('이번 달 주요 소식을 전달드립니다. 별도 회신은 필요하지 않습니다.', {
    subject: '월간 뉴스레터',
    from: 'newsletter@example.com',
  });
  assert.equal(insight.status, 'reference');
  assert.ok(insight.nextActions.every((action) => action.actionType !== 'draft_reply'));
  assert.ok(insight.nextActions.length <= 1);
});

test('하나의 메일에 정확히 세 개의 회신 시나리오를 강제하지 않는다', () => {
  const insight = analyze('내일까지 수정 견적서를 회신 부탁드립니다.', {
    subject: '수정 견적 요청',
  });
  assert.equal(insight.nextActions.length, 1);
  assert.equal(insight.nextActions[0].actionType, 'draft_reply');
});

test('범용 코어는 Sangfor 자료 공유를 모든 메일에 제안하지 않는다', () => {
  const insight = analyze('계약 조건 검토 후 의견을 회신 부탁드립니다.', {
    subject: '계약 검토 요청',
  });
  const serialized = JSON.stringify(insight.nextActions).toLowerCase();
  assert.equal(serialized.includes('sangfor'), false);
});

test('과거 인용 메일의 긴급 요청을 현재 요청으로 재분류하지 않는다', () => {
  const insight = analyze(`처리 완료했습니다. 추가 조치 없습니다.

-----Original Message-----
오늘 중 긴급 재작업 부탁드립니다.`);
  assert.equal(insight.status, 'done');
  assert.equal(insight.nextActions[0].actionType, 'monitor');
});

test('회신 불필요여도 상대방 승인 대기 상태는 waiting으로 유지한다', () => {
  const insight = analyze('고객 보안팀 승인 대기 중입니다. 현재 별도 회신은 필요 없습니다.');
  assert.equal(insight.status, 'waiting');
  assert.equal(insight.nextActions[0].actionType, 'monitor');
});

test('중요도 high만으로 명시적인 no-action 메일을 긴급 처리하지 않는다', () => {
  const insight = analyze('참고용 공지입니다. 별도 조치나 회신은 필요하지 않습니다.', {
    subject: '참고 공지',
    importance: 'high',
  });
  assert.equal(insight.status, 'reference');
});
