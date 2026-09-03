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
  assert.equal(parsed.residualText, '견적');
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


test('업무 도메인 합성어는 잘린 잔여 토큰 없이 원문 검색어를 보존한다', () => {
  const order = parseIntelligentQuery('발주서', { now });
  assert.equal(order.residualText, '발주서');
  assert.notEqual(order.residualText, '서');

  const completion = parseIntelligentQuery('계약완료', { now });
  assert.equal(completion.residualText, '계약완료');
  assert.deepEqual(completion.filters.workStates, []);

  const security = parseIntelligentQuery('보안 관련', { now });
  assert.equal(security.residualText, '보안');
});

test('동일 신호의 넓은 스마트뷰 용어는 OR 검색으로 유지한다', () => {
  const commercial = parseIntelligentQuery('견적 계약 발주', { now });
  assert.equal(commercial.residualOperator, 'OR');
  assert.match(commercial.residualText, /견적/);
  assert.match(commercial.residualText, /계약/);
  assert.match(commercial.residualText, /발주/);
  assert.equal(parseIntelligentQuery('고객 회신 대기', { now }).residualText, '');
});


test('단일 장애·보안 질의는 분류 신호 강제필터가 아니라 원문 검색으로 동작한다', () => {
  for (const query of ['장애', '보안', 'security']) {
    const parsed = parseIntelligentQuery(query, { now });
    assert.deepEqual(parsed.filters.signals, []);
    assert.match(parsed.residualText.toLowerCase(), new RegExp(query.toLowerCase()));
    assert.equal(parsed.residualOperator, 'OR');
    assert.equal(parsed.filters.lexicalIncidentSearch, true);
    assert.ok(parsed.recognized.some((item) => item.type === 'lexicalSignal'));
  }
});


test('장애·보안 단일 검색은 운영 용어 동의어를 확장한다', () => {
  const incident = parseIntelligentQuery('장애', { now });
  assert.match(incident.residualText, /오류/);
  assert.match(incident.residualText, /outage/);
  const security = parseIntelligentQuery('보안', { now });
  assert.match(security.residualText, /security/i);
  assert.match(security.residualText, /vpn/i);
});

test('incident lexical query preserves the requested kind for strict ranking', () => {
  assert.equal(parseIntelligentQuery('장애', { now }).filters.lexicalIncidentKind, '장애');
  assert.equal(parseIntelligentQuery('보안', { now }).filters.lexicalIncidentKind, '보안');
  assert.equal(parseIntelligentQuery('security', { now }).filters.lexicalIncidentKind, 'security');
});

test('qa-fix7 복합 지원·HCI 장애 질의는 의미 Intent로 파싱한다', () => {
  const completedSupport = parseIntelligentQuery('완료된 패치 티켓', { now });
  assert.equal(completedSupport.version, 'intelligent-search-v1.2.2');
  assert.equal(completedSupport.filters.semanticIntent, 'completed_support_ticket');
  assert.deepEqual(completedSupport.filters.workStates, ['completed']);
  assert.equal(completedSupport.residualText, '');

  const hciIncident = parseIntelligentQuery('HCI 라이선스 장애', { now });
  assert.equal(hciIncident.filters.semanticIntent, 'hci_license_incident');
  assert.deepEqual(hciIncident.filters.signals, []);
  assert.equal(hciIncident.residualText, '');
});

test('qa-fix8 독립 검색 실패 질의를 의미 Intent와 구조화 상태로 파싱한다', () => {
  const completedSangfor = parseIntelligentQuery('완료된 Sangfor 지원 문의', { now });
  assert.equal(completedSangfor.version, 'intelligent-search-v1.2.2');
  assert.equal(completedSangfor.filters.semanticIntent, 'completed_sangfor_support');
  assert.deepEqual(completedSangfor.filters.workStates, ['completed']);
  assert.equal(completedSangfor.residualText, '');

  const waitingLicense = parseIntelligentQuery('대기 중인 라이선스 회신', { now });
  assert.equal(waitingLicense.filters.semanticIntent, 'waiting_license_reply');
  assert.deepEqual(waitingLicense.filters.workStates, ['waiting']);
  assert.deepEqual(waitingLicense.filters.nextActors, ['external_party']);
  assert.equal(waitingLicense.residualText, '');

  const invoiceReview = parseIntelligentQuery('검토 필요한 세금계산서', { now });
  assert.equal(invoiceReview.filters.semanticIntent, 'tax_invoice_review');
  assert.deepEqual(invoiceReview.filters.workStates, ['review_required']);
  assert.ok(invoiceReview.filters.signals.includes('quotation_contract'));

  const deactivation = parseIntelligentQuery('Confluence 비활성화', { now });
  assert.equal(deactivation.filters.semanticIntent, 'confluence_deactivation');
  assert.deepEqual(deactivation.filters.workStates, ['action_required']);
  assert.deepEqual(deactivation.filters.nextActors, ['me']);

  const sharedAccess = parseIntelligentQuery('공유 폴더 이메일 인증', { now });
  assert.equal(sharedAccess.filters.semanticIntent, 'shared_access_verification');
  assert.deepEqual(sharedAccess.filters.workStates, ['action_required']);
  assert.deepEqual(sharedAccess.filters.nextActors, ['me']);

  const sangforIag = parseIntelligentQuery('Sangfor IAG', { now });
  assert.equal(sangforIag.filters.semanticIntent, 'sangfor_iag');
  assert.equal(sangforIag.residualText, '');
});
