import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dueRangeFor,
  explainIntelligentMatch,
  intelligentSmartViews,
  parseIntelligentQuery,
} from '../src/domain/intelligent-search.js';

const now = new Date('2026-08-30T00:00:00.000Z');

test('한국어 자연어 질의를 상태·행동 주체·기한·보조 신호로 파싱한다', () => {
  const parsed = parseIntelligentQuery('오늘 내가 처리할 긴급 견적 메일', { now });
  assert.deepEqual(parsed.filters.workStates, ['action_required']);
  assert.deepEqual(parsed.filters.nextActors, ['me']);
  assert.deepEqual(parsed.filters.priorities, ['critical', 'high']);
  assert.ok(parsed.filters.signals.includes('quotation_contract'));
  assert.equal(parsed.filters.dueFilter, 'today');
  assert.equal(parsed.hasStructuredFilters, true);
});

test('고객 회신 대기는 waiting + external_party로 해석한다', () => {
  const parsed = parseIntelligentQuery('고객 회신 대기', { now });
  assert.deepEqual(parsed.filters.workStates, ['waiting']);
  assert.deepEqual(parsed.filters.nextActors, ['external_party']);
});

test('프로젝트 명시 구문과 남은 전문검색어를 분리한다', () => {
  const parsed = parseIntelligentQuery('프로젝트:"선진 HCI 구축" 정책표 승인', { now });
  assert.equal(parsed.filters.project, '선진 HCI 구축');
  assert.ok(parsed.filters.signals.includes('approval'));
  assert.match(parsed.residualText, /정책표/);
});

test('오늘·내일·기한 초과 범위를 KST 기준으로 생성한다', () => {
  const today = dueRangeFor('today', now);
  const tomorrow = dueRangeFor('tomorrow', now);
  const overdue = dueRangeFor('overdue', now);
  assert.ok(today.from < today.before);
  assert.equal(tomorrow.from, today.before);
  assert.equal(overdue.before, today.from);
  assert.equal(overdue.requiresDue, true);
});

test('검토 필요 질의는 review_required 필터를 만든다', () => {
  const parsed = parseIntelligentQuery('분류 불확실한 메일', { now });
  assert.deepEqual(parsed.filters.workStates, ['review_required']);
  assert.equal(parsed.filters.reviewOnly, true);
});

test('질의 길이와 빈 질의를 fail-closed로 거부한다', () => {
  assert.throws(() => parseIntelligentQuery(''), /required/i);
  assert.throws(() => parseIntelligentQuery('x'.repeat(501)), /500/);
});

test('스마트 뷰는 Outlook 폴더 변경 없이 안정적인 업무 관점을 제공한다', () => {
  const views = intelligentSmartViews(now);
  assert.ok(views.length >= 8);
  assert.equal(new Set(views.map((item) => item.id)).size, views.length);
  assert.ok(views.some((item) => item.id === 'my-actions'));
  assert.ok(views.some((item) => item.id === 'review-required'));
  assert.ok(views.every((item) => item.query && item.filters));
});

test('검색 결과에 구조화된 일치 이유를 설명한다', () => {
  const parsed = parseIntelligentQuery('오늘 내가 처리할 견적', { now });
  const reasons = explainIntelligentMatch({
    classification: {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'high',
      dueAt: '2026-08-30T09:00:00.000Z',
      signals: ['deadline', 'quotation_contract'],
    },
  }, parsed);
  assert.ok(reasons.some((item) => item.includes('업무 상태')));
  assert.ok(reasons.some((item) => item.includes('다음 행동 주체')));
  assert.ok(reasons.some((item) => item.includes('보조 신호')));
});
