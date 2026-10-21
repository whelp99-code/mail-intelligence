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

test('절대 날짜는 같은 절의 deadline cue가 있을 때만 KST hard due anchor가 된다', () => {
  const hard = parseIntelligentQuery('2026-09-10까지 견적 회신', { now });
  assert.deepEqual(hard.filters.dueRange, {
    from: '2026-09-09T15:00:00.000Z',
    before: '2026-09-10T15:00:00.000Z',
    requiresDue: true,
  });
  assert.equal(hard.searchPlan.hardAnchors[0].kind, 'due_date');

  const soft = parseIntelligentQuery('2026-09-10 견적 문서', { now });
  assert.deepEqual(soft.filters.dueRange, {});
  assert.equal(soft.searchPlan.hardAnchors.some((item) => item.kind === 'due_date'), false);

  const koreanDate = parseIntelligentQuery('2026년 9월 10일까지 견적 회신', { now });
  assert.deepEqual(koreanDate.filters.dueRange, hard.filters.dueRange);
  const monthDay = parseIntelligentQuery('9월 10일 마감 견적', { now });
  assert.deepEqual(monthDay.filters.dueRange, hard.filters.dueRange);

  const laterClause = parseIntelligentQuery('2026-09-01 논의, 2026-09-10까지 회신', { now });
  assert.deepEqual(laterClause.filters.dueRange, hard.filters.dueRange);
  const englishClause = parseIntelligentQuery('2026-09-01 discussed; reply due by 2026-09-10', { now });
  assert.deepEqual(englishClause.filters.dueRange, hard.filters.dueRange);
  const sameClause = parseIntelligentQuery('2026-09-01 discussed then reply by 2026-09-10', { now });
  assert.deepEqual(sameClause.filters.dueRange, hard.filters.dueRange);
  const koreanClause = parseIntelligentQuery('2026년 9월 1일 참고; 9월 10일 회신 마감', { now });
  assert.deepEqual(koreanClause.filters.dueRange, hard.filters.dueRange);
  const invalid = parseIntelligentQuery('2026-02-30까지 회신', { now });
  assert.deepEqual(invalid.filters.dueRange, {});
});

test('명시 프로젝트 구문 외 임의 잔여 토큰은 hard entity anchor가 되지 않는다', () => {
  const parsed = parseIntelligentQuery('AlphaCorp 견적 계약', { now });
  assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'entity'), false);
});

test('원격과 보안 또는 장애 issue group은 hard anchor가 되고 명시 결합만 모두 요구한다', () => {
  const anchored = parseIntelligentQuery('원격 접속 보안 사고', { now });
  assert.ok(anchored.searchPlan.hardAnchors.some((item) => item.kind === 'security_remote_session'));
  const ordinary = parseIntelligentQuery('원격 접속 오류', { now });
  assert.equal(ordinary.searchPlan.hardAnchors.some((item) => item.kind === 'security_remote_session'), false);

  const outage = parseIntelligentQuery('원격 접속 보안 장애', { now });
  assert.equal(outage.searchPlan.hardAnchors.find((item) => item.kind === 'security_remote_session').requiresAllIssueTerms, false);
  const explicit = parseIntelligentQuery('원격 접속 보안 및 장애', { now });
  assert.equal(explicit.searchPlan.hardAnchors.find((item) => item.kind === 'security_remote_session').requiresAllIssueTerms, true);
  assert.deepEqual(explicit.filters.signals, []);
  assert.deepEqual(parseIntelligentQuery('보안 점검', { now }).filters.signals, ['incident_security']);
});

test('자동 생성 문서의 조사와 보조형 control words는 coverage soft token 분모에 포함하지 않는다', () => {
  const parsed = parseIntelligentQuery('자동 생성되는 문서를 메일 확인하면', { now });
  assert.deepEqual(parsed.searchPlan.softTokens, []);
  assert.equal(parsed.searchPlan.fallbackPolicy.allowed, false);
  assert.equal(parsed.searchPlan.fallbackPolicy.failClosed, true);

  const core = parseIntelligentQuery('자동 생성 문서 세금계산서를 확인하는', { now });
  assert.deepEqual(core.searchPlan.softTokens, ['세금계산서']);
  assert.equal(core.searchPlan.fallbackPolicy.allowed, false);

  const standalone = parseIntelligentQuery('하면 하는 해서 되는 되어 될 세금계산서', { now });
  assert.deepEqual(standalone.searchPlan.softTokens, ['세금계산서']);
  assert.equal(standalone.searchPlan.fallbackPolicy.allowed, false);
});

test('semantic intent consumes only recognized control spans and keeps entity qualifiers in the search plan', () => {
  const parsed = parseIntelligentQuery('완료된 Sangfor 지원 문의 고객', { now });
  assert.equal(parsed.filters.semanticIntent, 'completed_sangfor_support');
  assert.match(parsed.residualText, /Sangfor/);
  assert.deepEqual(parsed.filters.nextActors, ['external_party']);
  assert.ok(parsed.searchPlan.softTokens.includes('Sangfor'));
});

test('bounded particle equivalence preserves business content without arbitrary verb stemming', () => {
  const commercial = parseIntelligentQuery('세금계산서를 발주서와 확인', { now });
  assert.ok(commercial.searchPlan.softTokens.includes('세금계산서'));
  assert.ok(commercial.searchPlan.softTokens.includes('발주서'));

  const nonControlVerb = parseIntelligentQuery('협의하는 세금계산서', { now });
  assert.ok(nonControlVerb.searchPlan.softTokens.includes('협의하는'));
  assert.ok(nonControlVerb.searchPlan.softTokens.includes('세금계산서'));
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

test('long-question decomposition keeps ten keywords but refuses eleven without truncating', () => {
  const ten = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
  assert.equal(parseIntelligentQuery(ten).searchPlan.softTokens.length, 10);
  const decomposed = parseIntelligentQuery(`Please ${ten}`);
  assert.equal(decomposed.searchPlan.softTokens.length, 10);
  assert.equal(decomposed.searchPlan.fallbackPolicy.failClosed, false);
  const refused = parseIntelligentQuery(`${ten} lambda`);
  assert.equal(refused.searchPlan.softTokens.length, 11);
  assert.equal(refused.searchPlan.fallbackPolicy.failClosed, true);
  assert.equal(refused.searchPlan.fallbackPolicy.allowed, false);
  assert.equal(parseIntelligentQuery('Can you please show me what information is in the mail').searchPlan.fallbackPolicy.failClosed, true);
});

test('decomposition retains unknown business words and identifier particles without arbitrary stemming', () => {
  const parsed = parseIntelligentQuery('Please can you show me what ZX-2048의 협의하는 유지보수 AlphaCorp details are');
  assert.deepEqual(parsed.searchPlan.softTokens, ['ZX-2048', '협의하는', '유지보수', 'AlphaCorp']);
  assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier' && item.value === 'ZX-2048'));
});

test('temporal units are not identifiers and unparsed periods keep their lexical meaning', () => {
  for (const token of ['2026년', '9월', '10일', '10일까지', '2주', '1주일', '3분기', '2개월', '2026년9월10일', '2026년3분기', '1년2개월', '1개월2주3일', '2주동안', '3분기부터', '3분기까지', '2주이내', '3일전', '3일후', '2개월간', '2026-09-10']) {
    const parsed = parseIntelligentQuery(`Please can you show me the latest information about ${token} alpha beta`);
    assert.ok(parsed.searchPlan.softTokens.includes(token), token);
    assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier'), false, token);
    assert.deepEqual(parsed.filters.dueRange, {}, token);
    assert.equal(parsed.searchPlan.fallbackPolicy.allowed, false, token);
  }
  for (const token of ['EPO2609-164', '49725', 'A2026년', '2026년형', '9월호', '3분기보고서', 'EPO-2026-09-10']) {
    const parsed = parseIntelligentQuery(`Please can you show me the latest information about ${token} alpha beta`);
    assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier' && item.value === token), token);
  }
});

test('selected Korean due-date spans become metadata filters, not lexical requirements', () => {
  for (const date of ['2026년 9월 10일까지', '2026년9월10일까지', '9월 10일까지', '2026-09-10까지', '2026/09/10까지', '2026.09.10까지']) {
    const parsed = parseIntelligentQuery(`지금 가장 최근에 어떤 내용을 메일에서 찾아서 보여줘 ${date} alpha beta`, { now });
    assert.deepEqual(parsed.searchPlan.softTokens, ['alpha', 'beta'], date);
    assert.deepEqual(parsed.filters.dueRange, { from: '2026-09-09T15:00:00.000Z', before: '2026-09-10T15:00:00.000Z', requiresDue: true }, date);
    assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'due_date'), date);
    assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier'), false, date);
  }
  const invalid = parseIntelligentQuery('지금 가장 최근에 어떤 내용을 메일에서 찾아서 보여줘 2026년 2월 30일까지 alpha beta', { now });
  assert.deepEqual(invalid.filters.dueRange, {});
  assert.ok(invalid.searchPlan.softTokens.includes('30일까지'));
  assert.equal(invalid.searchPlan.hardAnchors.some((item) => item.kind === 'due_date'), false);
  assert.equal(invalid.searchPlan.fallbackPolicy.failClosed, true);
  const separateDates = parseIntelligentQuery('지금 가장 최근에 어떤 내용을 메일에서 찾아서 보여줘 2026년9월1일; 2026년9월10일까지 alpha beta', { now });
  assert.ok(separateDates.searchPlan.softTokens.includes('2026년9월1일'));
  assert.equal(separateDates.filters.dueRange.from, '2026-09-09T15:00:00.000Z');
  const ten = 'EPO2609-164 49725 alpha beta gamma delta epsilon zeta eta theta';
  const atBudget = parseIntelligentQuery(`지금 가장 최근에 어떤 내용을 메일에서 찾아서 보여줘 2026년 9월 10일까지 ${ten}`, { now });
  assert.equal(atBudget.searchPlan.softTokens.length, 10);
  assert.equal(atBudget.searchPlan.fallbackPolicy.failClosed, false);
  const overBudget = parseIntelligentQuery(`${atBudget.originalQuery} iota`, { now });
  assert.equal(overBudget.searchPlan.softTokens.length, 11);
  assert.equal(overBudget.searchPlan.fallbackPolicy.failClosed, true);
  assert.equal(overBudget.searchPlan.fallbackPolicy.allowed, false);
});

test('decomposed Korean date units stay on the due anchor and are not required identifiers', () => {
  const parsed = parseIntelligentQuery('Please can you show me alpha beta details by 2026년 9월 10일까지 please', { now });
  assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'due_date'), true);
  assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier'), false);
  assert.deepEqual(parsed.searchPlan.softTokens, ['alpha', 'beta']);

  const withoutCue = parseIntelligentQuery('Please can you show me the latest alpha beta information about 2026년 9월 10일 please', { now });
  assert.equal(withoutCue.filters.dueRange.from, undefined);
  assert.equal(withoutCue.searchPlan.hardAnchors.some((item) => item.kind === 'identifier'), false);
  assert.ok(withoutCue.searchPlan.softTokens.includes('2026년'));
  assert.ok(withoutCue.searchPlan.softTokens.includes('9월'));
  assert.ok(withoutCue.searchPlan.softTokens.includes('10일'));
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
  assert.equal(completedSupport.version, 'intelligent-search-v1.2.2-fix13');
  assert.equal(completedSupport.filters.semanticIntent, 'completed_support_ticket');
  assert.deepEqual(completedSupport.filters.workStates, ['completed']);
  assert.equal(completedSupport.residualText, '');

  const hciIncident = parseIntelligentQuery('HCI 라이선스 장애', { now });
  assert.equal(hciIncident.filters.semanticIntent, 'hci_license_incident');
  assert.deepEqual(hciIncident.filters.signals, []);
  assert.equal(hciIncident.residualText, 'HCI 라이선스 장애');
});

test('qa-fix8 독립 검색 실패 질의를 의미 Intent와 구조화 상태로 파싱한다', () => {
  const completedSangfor = parseIntelligentQuery('완료된 Sangfor 지원 문의', { now });
  assert.equal(completedSangfor.version, 'intelligent-search-v1.2.2-fix13');
  assert.equal(completedSangfor.filters.semanticIntent, 'completed_sangfor_support');
  assert.deepEqual(completedSangfor.filters.workStates, ['completed']);
  assert.equal(completedSangfor.residualText, 'Sangfor');

  const waitingLicense = parseIntelligentQuery('대기 중인 라이선스 회신', { now });
  assert.equal(waitingLicense.filters.semanticIntent, 'waiting_license_reply');
  assert.deepEqual(waitingLicense.filters.workStates, ['waiting']);
  assert.deepEqual(waitingLicense.filters.nextActors, ['external_party']);
  assert.equal(waitingLicense.residualText, '라이선스');

  const invoiceReview = parseIntelligentQuery('검토 필요한 세금계산서', { now });
  assert.equal(invoiceReview.filters.semanticIntent, 'tax_invoice_review');
  assert.deepEqual(invoiceReview.filters.workStates, ['review_required']);
  assert.ok(invoiceReview.filters.signals.includes('quotation_contract'));
  assert.equal(invoiceReview.residualText, '세금계산서');

  const deactivation = parseIntelligentQuery('Confluence 비활성화', { now });
  assert.equal(deactivation.filters.semanticIntent, 'confluence_deactivation');
  assert.deepEqual(deactivation.filters.workStates, ['action_required']);
  assert.deepEqual(deactivation.filters.nextActors, ['me']);
  assert.equal(deactivation.residualText, 'Confluence');

  const sharedAccess = parseIntelligentQuery('공유 폴더 이메일 인증', { now });
  assert.equal(sharedAccess.filters.semanticIntent, 'shared_access_verification');
  assert.deepEqual(sharedAccess.filters.workStates, ['action_required']);
  assert.deepEqual(sharedAccess.filters.nextActors, ['me']);
  assert.equal(sharedAccess.residualText, '공유 폴더');

  const sangforIag = parseIntelligentQuery('Sangfor IAG', { now });
  assert.equal(sangforIag.filters.semanticIntent, 'sangfor_iag');
  assert.equal(sangforIag.residualText, 'Sangfor IAG');
});

test('review 4342846497 removes message-query scaffolding without removing business terms', () => {
  const parsed = parseIntelligentQuery('Could you please find the most recent message from ZX-2048 in my mailbox?');
  assert.deepEqual(parsed.searchPlan.softTokens, ['ZX-2048']);
  const mixed = parseIntelligentQuery('Could you please find messages from ZX-2048 받은편지함 메일함에서 내용을 찾아주세요 alpha renewal');
  assert.ok(mixed.searchPlan.softTokens.includes('renewal'));
  assert.equal(mixed.searchPlan.softTokens.includes('메일함에서'), false);
});

test('review 4342846504 computes anchored coverage after identifier admission', () => {
  const parsed = parseIntelligentQuery('Please can you show me the latest details about ZX-2048 alpha beta gamma');
  assert.equal(parsed.searchPlan.softTokens.length, 4);
  assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier'));
  assert.equal(parsed.searchPlan.fallbackPolicy.minimumCoverage, 2);
  const ordinary = parseIntelligentQuery('Please can you show me the latest details about alpha beta gamma delta');
  assert.equal(ordinary.searchPlan.fallbackPolicy.minimumCoverage, 3);
});

test('review 4342846508 distinguishes reference numbers from amounts and dates', () => {
  const identifiers = (query) => parseIntelligentQuery(query).searchPlan.hardAnchors
    .filter((item) => item.kind === 'identifier').map((item) => item.value);
  for (const label of ['invoice', 'order', 'ticket', 'case', 'quote', 'quotation', '인보이스', '주문', '티켓', '견적', '참조번호']) {
    assert.ok(identifiers(`Please can you find the latest details about ${label} 42 Acme renewal`).includes('42'), label);
  }
  assert.ok(identifiers('ticket 7 Acme renewal project').includes('7'));
  for (const token of ['123456', '49725', 'EPO2609-164', 'ZX-2048']) {
    assert.ok(identifiers(`Please can you find the latest details about ${token} Acme renewal`).includes(token), token);
  }
  assert.equal(identifiers('Please can you find the latest details about 2026 Acme renewal').includes('2026'), false);
  for (const amount of ['$123456', '₩49725', 'USD 123456', 'USD123456', '49725 KRW', '49725KRW', '123456원', '금액 123456', 'amount 123456', '123456.78']) {
    assert.deepEqual(identifiers(`Please can you find the latest details about ${amount} Acme renewal`), [], amount);
  }
  assert.ok(identifiers('Please find the latest invoice 123456 with amount USD 123456 in my mail').includes('123456'));
});

test('review 4342846527 applies the same Unicode word budget across punctuation', () => {
  const ten = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
  for (const separator of [',', ';', '/', '·', '，', '：']) {
    const atLimit = parseIntelligentQuery(ten.join(separator));
    assert.deepEqual(atLimit.searchPlan.softTokens, ten, separator);
    const above = parseIntelligentQuery([...ten, 'lambda'].join(separator));
    assert.equal(above.searchPlan.softTokens.length, 11, separator);
    assert.equal(above.searchPlan.fallbackPolicy.failClosed, true, separator);
    assert.equal(above.searchPlan.fallbackPolicy.allowed, false, separator);
  }
  const code = parseIntelligentQuery('Could,you,please,find,the,most,recent,message,from,ZX-2048,in,my,mailbox?');
  assert.deepEqual(code.searchPlan.softTokens, ['ZX-2048']);
});

test('review 4342976943 ignores date-shaped substrings inside complete identifiers', () => {
  for (const code of ['EPO-2026-13-10', 'EPO-2026-09-10', 'X_2026-13-10', '한글2026-13-10', '2026-13-10한글', 'EPO-2026-09-10-A']) {
    const parsed = parseIntelligentQuery(`Please can you show me the latest details about ${code} sent by Alice`);
    assert.equal(parsed.searchPlan.fallbackPolicy.failClosed, false, code);
    assert.deepEqual(parsed.filters.dueRange, {}, code);
    assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.kind === 'identifier' && item.value === code), code);
  }
  const actual = parseIntelligentQuery('Please can you show me the latest details by 2026-09-10 for EPO-2026-13-10 alpha', { now });
  assert.equal(actual.filters.dueRange.from, '2026-09-09T15:00:00.000Z');
  const invalid = parseIntelligentQuery('Please can you show me the latest details by 2026-13-10 for EPO-2026-13-10 alpha', { now });
  assert.equal(invalid.searchPlan.fallbackPolicy.failClosed, true);
});

test('review 4342976950 consumes only explicit result quantities as limit hints', () => {
  for (const phrase of ['the 10 most recent', 'latest 10', 'most recent 10', 'top 10', '최근10건', '최신 10개']) {
    const parsed = parseIntelligentQuery(`Could you please show me ${phrase} alpha beta gamma messages in my mailbox`);
    assert.equal(parsed.limitHint, 10, phrase);
    assert.equal(parsed.searchPlan.softTokens.includes('10'), false, phrase);
    assert.equal(parsed.searchPlan.hardAnchors.some((item) => item.value === '10'), false, phrase);
    assert.ok(parsed.searchPlan.softTokens.includes('alpha'), phrase);
  }
  const number = parseIntelligentQuery('Could you please show me the latest ticket 10 alpha beta gamma in my mailbox');
  assert.equal(number.limitHint, null);
  assert.ok(number.searchPlan.hardAnchors.some((item) => item.value === '10'));
  const mixed = parseIntelligentQuery('Please show the latest 2 invoice 49725 details with amount USD123456 by 2026-09-10');
  assert.equal(mixed.limitHint, 2);
  assert.deepEqual(mixed.searchPlan.hardAnchors.filter((item) => item.kind === 'identifier').map((item) => item.value), ['49725']);
  const literal = parseIntelligentQuery('Please find the most recent messages for project:"Top 10" with ZX-2048');
  assert.equal(literal.limitHint, null);
  assert.equal(literal.filters.project, 'Top 10');
  const ten = 'alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa';
  assert.equal(parseIntelligentQuery(`top 2 ${ten}`).searchPlan.softTokens.length, 10);
  assert.equal(parseIntelligentQuery(`top 2 ${ten},lambda`).searchPlan.fallbackPolicy.failClosed, true);
});

test('review 4342976956 normalizes every shared control particle without English suffix damage', () => {
  for (const particle of ['에게', '에서', '으로', '만', '도', '을', '를', '이', '가', '은', '는', '과', '와', '에', '로', '의', '로만', '으로도']) {
    for (const query of [`ZX-2048${particle} 찾아주세요`, `Please can you show me the latest details about ZX-2048${particle} alpha beta`]) {
      const parsed = parseIntelligentQuery(query);
      assert.deepEqual(parsed.searchPlan.hardAnchors.filter((item) => item.kind === 'identifier').map((item) => item.value), ['ZX-2048'], query);
    }
  }
  for (const code of ['ZX-2048Pro', 'ZX-2048Man', 'ZX-2048A', '모델123', 'RO2048', 'ZX-2048로봇']) {
    const parsed = parseIntelligentQuery(`Please can you show me the latest details about ${code} alpha beta`);
    assert.ok(parsed.searchPlan.hardAnchors.some((item) => item.value === code), code);
  }
  assert.ok(parseIntelligentQuery('ticket 7로 찾아주세요').searchPlan.hardAnchors.some((item) => item.value === '7'));
});
