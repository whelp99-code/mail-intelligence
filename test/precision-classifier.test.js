import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPrecisionCorrection,
  classificationFingerprint,
  classifyMessage,
  extractDue,
  normalizePrecisionCorrection,
  resolveProject,
  splitMessageHistory,
  stripQuotedHistory,
  validateClassificationEvidence,
} from '../src/domain/precision-classifier.js';

const receivedAt = '2026-08-30T00:00:00.000Z';

function message(overrides = {}) {
  return {
    id: overrides.id || 'message-1',
    subject: overrides.subject || '업무 메일',
    from: overrides.from || 'customer@example.com',
    fromName: overrides.fromName || '고객 담당자',
    receivedAt: overrides.receivedAt || receivedAt,
    body: overrides.body || '',
    bodyPreview: overrides.bodyPreview || overrides.body || '',
    importance: overrides.importance || 'normal',
    hasAttachments: Boolean(overrides.hasAttachments),
    isOutgoing: Boolean(overrides.isOutgoing),
    ...overrides,
  };
}

test('현재 요청은 인용된 과거 완료보다 우선하고 정확한 한 상태만 만든다', () => {
  const result = classifyMessage(message({
    subject: '수정 견적서 요청',
    body: '내일 오후 3시까지 수정 견적서를 보내주세요.\n\n-----Original Message-----\n기존 검토는 완료했습니다.',
  }), { now: new Date(receivedAt) });

  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'high');
  assert.equal(result.duePrecision, 'relative');
  assert.match(result.dueText, /내일/);
  assert.equal(result.legacyStatus, 'urgent');
  assert.match(result.evidence.workState.text, /수정 견적서/);
});

test('뉴스레터와 명시적 무조치 메일은 참고로 남고 액터는 없다', () => {
  const result = classifyMessage(message({
    subject: '월간 뉴스레터',
    body: '이번 달 주요 소식입니다. 별도 회신은 필요 없습니다.',
  }));

  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.reviewStatus, 'auto');
});

test('현재 직접 요청은 자동 알림 표현보다 우선해 archive로 강등되지 않는다', () => {
  const result = classifyMessage(message({
    subject: '자동 알림: 정책표 요청',
    from: 'notification@example.com',
    body: '자동 시스템 알림입니다. 오늘까지 보안 정책표를 보내주세요.',
  }), { now: new Date(receivedAt) });

  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.operational.lane, 'do_now');
});

test('외부 승인 대기와 내부 검토 대기를 다음 행동 주체로 분리한다', () => {
  const external = classifyMessage(message({
    body: '방화벽 정책표는 고객 보안팀 승인 대기 상태입니다.',
  }));
  assert.equal(external.workState, 'waiting');
  assert.equal(external.nextActor, 'external_party');

  const internal = classifyMessage(message({
    id: 'message-2',
    body: '견적서는 내부 영업팀 검토 대기 상태입니다.',
  }));
  assert.equal(internal.workState, 'waiting');
  assert.equal(internal.nextActor, 'internal_team');
});

test('결정 요청은 action이 아니라 decision_required로 분류한다', () => {
  const result = classifyMessage(message({
    body: '두 가지 구축안 중 최종 선택과 승인 부탁드립니다.',
  }));
  assert.equal(result.workState, 'decision_required');
  assert.equal(result.nextActor, 'me');
});

test('구체성이 없는 확인 바랍니다 문장은 억지 업무가 아니라 검토 필요다', () => {
  const result = classifyMessage(message({ body: '확인 바랍니다.' }));
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.ok(result.reviewReasons.includes('insufficient_action_evidence'));
});

test('내가 보낸 요청은 외부 회신 대기 상태로 전환한다', () => {
  const result = classifyMessage(message({
    from: 'me@example.com',
    fromName: '박재민',
    body: '고객 담당자님, 내일까지 정책표를 보내주세요.',
    isOutgoing: true,
  }), { mailboxAddress: 'me@example.com' });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('외부의 구체적 이행 약속은 waiting + external_party다', () => {
  const result = classifyMessage(message({
    body: '수정된 정책표는 내일 오전까지 보내드리겠습니다.',
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('승인된 프로젝트 레지스트리의 정확한 별칭 하나만 자동 연결한다', () => {
  const projects = [{ id: 7, projectKey: 'sunjin-hci', name: '선진 HCI 구축', aliases: ['선진 HCI'] }];
  const result = classifyMessage(message({
    subject: '[선진 HCI] 수정 견적서',
    body: '내일까지 수정 견적서를 보내주세요.',
  }), { projects });
  assert.equal(result.primaryProjectId, 7);
  assert.equal(result.projectResolution, 'confirmed');
  assert.equal(result.projectCandidate.name, '선진 HCI 구축');
});

test('여러 프로젝트 별칭이 함께 일치하면 임의 선택하지 않고 review_required로 둔다', () => {
  const projects = [
    { id: 7, name: '선진 HCI 구축', aliases: ['선진 HCI'] },
    { id: 8, name: '선진 보안 고도화', aliases: ['선진 보안'] },
  ];
  const result = resolveProject(message({
    subject: '선진 HCI / 선진 보안 공동 일정',
    body: '관련 자료를 검토해 주세요.',
  }), projects);
  assert.equal(result.primaryProjectId, null);
  assert.equal(result.projectResolution, 'review_required');
  assert.equal(result.projectCandidate.matches.length, 2);
});

test('등록되지 않은 대괄호 프로젝트명은 정식 프로젝트가 아니라 후보로만 둔다', () => {
  const result = classifyMessage(message({
    subject: '[Acme HCI PoC] 일정 확인',
    body: '내일까지 일정표를 보내주세요.',
  }));
  assert.equal(result.primaryProjectId, null);
  assert.equal(result.projectResolution, 'candidate');
  assert.equal(result.projectCandidate.label, 'Acme HCI PoC');
});

test('제한된 보조 신호만 생성하고 신호가 독립 업무 객체가 되지 않는다', () => {
  const result = classifyMessage(message({
    subject: '긴급 보안 장애 견적',
    body: '오늘 중 85,000,000원 견적서를 첨부드립니다. 보안 장애 대응 일정 승인 부탁드립니다.',
    hasAttachments: false,
  }));
  assert.deepEqual(result.signals, [
    'deadline',
    'amount',
    'quotation_contract',
    'attachment',
    'attachment_missing',
    'schedule',
    'approval',
    'incident_security',
  ]);
  assert.equal(result.priority, 'critical');
});

test('명시적 날짜와 상대 날짜를 KST 기준 ISO로 정규화한다', () => {
  const exact = extractDue('2026-09-03 오후 2시까지', new Date(receivedAt));
  assert.equal(exact.dueAt, '2026-09-03T05:00:00.000Z');
  assert.equal(exact.duePrecision, 'exact');

  const relative = extractDue('내일까지', new Date(receivedAt));
  assert.equal(relative.duePrecision, 'relative');
  assert.ok(relative.dueAt);
});

test('사용자 보정은 자동 판단보다 우선하고 보정 필드 신뢰도를 1로 만든다', () => {
  const original = classifyMessage(message({ body: '확인 바랍니다.' }));
  const correction = normalizePrecisionCorrection({
    workState: 'reference',
    nextActor: 'none',
    priority: 'low',
    clearProject: true,
    note: '단순 참고 메일',
  });
  const corrected = applyPrecisionCorrection(original, correction);
  assert.equal(corrected.workState, 'reference');
  assert.equal(corrected.nextActor, 'none');
  assert.equal(corrected.priority, 'low');
  assert.equal(corrected.reviewStatus, 'corrected');
  assert.equal(corrected.confidence.workState, 1);
  assert.equal(corrected.source, 'user-corrected');
});

test('동일한 분류 내용은 안정적인 fingerprint를 만든다', () => {
  const first = classifyMessage(message({ body: '내일까지 수정 견적서를 보내주세요.' }), { now: new Date(receivedAt) });
  const second = classifyMessage(message({ body: '내일까지 수정 견적서를 보내주세요.' }), { now: new Date(receivedAt) });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, classificationFingerprint(first));
});

test('인용문과 서명은 현재 상태 판단에서 제거한다', () => {
  const stripped = stripQuotedHistory('현재 내용입니다.\n\n감사합니다.\n박재민\n\nFrom: old@example.com\n기존 요청을 처리해 주세요.');
  assert.equal(stripped, '현재 내용입니다.');
});


test('Forwarded message 구분선 뒤 과거 요청은 현재 행동과 기한으로 승격되지 않는다', () => {
  const result = classifyMessage(message({
    subject: 'Fwd: 오늘까지 제출 요청',
    body: '아래 내용 참고 바랍니다.\n\n---------- Forwarded message ----------\nFrom: old@example.com\nDate: 2026-08-01\nSubject: 제출 요청\n오늘까지 제출 바랍니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.dueAt, null);
  assert.equal(result.contentBoundary.type, 'explicit-history-marker');
});

test('전달 본문 위 현재 요청은 현재 문장의 exact evidence로 행동을 만든다', () => {
  const input = message({
    subject: 'Fwd: 고객 요청',
    body: '아래 고객 요청대로 오늘까지 제안서를 제출해 주세요.\n\n-------- Forwarded Message --------\nFrom: customer@example.com\nSent: Friday\nTo: me@example.com\nSubject: old\n오늘까지 제출 바랍니다.',
  });
  const result = classifyMessage(input, { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.match(result.evidence.workState.exactText, /아래 고객 요청대로/);
  assert.equal(validateClassificationEvidence(result, input).ok, true);
});

test('영문·한글·모바일 Outlook 전달 헤더 묶음을 현재 본문과 분리한다', () => {
  for (const body of [
    'FYI only.\n\nBegin forwarded message:\nFrom: old@example.com\nDate: Friday\nTo: user@example.com\nSubject: old\nPlease submit today.',
    '참고 바랍니다.\n\n보낸 메시지 시작\n보낸 사람: old@example.com\n보낸 날짜: 금요일\n받는 사람: user@example.com\n제목: 이전 요청\n오늘까지 제출 바랍니다.',
    '참고 바랍니다.\n\nFrom: old@example.com\nSent: Friday\nTo: user@example.com\nSubject: old request\nPlease submit today.',
  ]) {
    const split = splitMessageHistory(body);
    assert.match(split.currentContent, /FYI only|참고 바랍니다/);
    assert.doesNotMatch(split.currentContent, /submit today|오늘까지 제출/);
    assert.ok(split.quotedContent);
  }
});

test('일반 본문의 단독 From 문구는 전달 헤더로 오인하지 않는다', () => {
  const body = '자료 출처는 From: field를 참고하세요.\n내일까지 문서를 보내주세요.';
  assert.equal(stripQuotedHistory(body), body);
});

test('분류 evidence는 subject/current body의 exact canonical span만 저장한다', () => {
  const input = message({
    subject: '',
    body: '내일 오후 3시까지 수정 견적서를 보내주세요.\n\n---------- Forwarded message ----------\n오늘까지 이전 자료를 제출 바랍니다.',
  });
  const result = classifyMessage(input, { now: new Date(receivedAt) });
  const validation = validateClassificationEvidence(result, input);
  assert.equal(validation.ok, true, JSON.stringify(validation.failures));
  for (const item of Object.values(result.evidence).filter(Boolean)) {
    assert.notEqual(item.exactText, '(제목 없음)');
    assert.equal(item.normalizationVersion, 'exact-source-span-v1');
  }
});

test('광고·웨비나는 구체적인 개인 업무 근거가 없으면 reference로 억제한다', () => {
  const result = classifyMessage(message({
    subject: '견적 계약 웨비나에 등록하세요',
    body: '이번 주 웨비나 이벤트 안내입니다. 할인 혜택을 확인 바랍니다. 수신거부 unsubscribe',
    isPromotional: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.dueAt, null);
});


test('한국어 Outlook 님이 작성 회신 헤더 뒤 과거 본문을 분리한다', () => {
  const body = [
    '현재 요청입니다. 수정 자료를 보내주세요.',
    '',
    '2026년 8월 27일 목요일 오후 4:21 홍길동 <old@example.com>님이 작성:',
    '요청하신 자료중에 전달 가능한 자료를 전달 드립니다.',
  ].join('\n');
  const split = splitMessageHistory(body);
  assert.equal(split.boundaryType, 'explicit-history-marker');
  assert.equal(split.currentContent, '현재 요청입니다. 수정 자료를 보내주세요.');
  assert.match(split.quotedContent, /요청하신 자료중에/);

  const input = message({ subject: 'Re: 자료 보완', body });
  const result = classifyMessage(input);
  assert.equal(result.workState, 'action_required');
  assert.match(result.evidence.workState.exactText, /수정 자료를 보내주세요/);
  assert.doesNotMatch(result.evidence.workState.exactText, /요청하신 자료중에/);
  assert.equal(validateClassificationEvidence(result, input).ok, true);
});


test('보낸 편지함의 견적·발주 요청은 WAITING / EXTERNAL_PARTY다', () => {
  const result = classifyMessage(message({
    subject: '견적 요청',
    body: '견적서를 수정해서 보내주세요. 그 후 바로 발주해주시면 감사드리겠습니다.',
    isOutgoing: true,
    folderName: '보낸 편지함',
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.reviewStatus, 'auto');
  assert.match(result.evidence.workState.rule, /outgoing-request/);
});

test('보낸 편지함의 자료 전달 후 확인 요청도 외부 회신 대기다', () => {
  const result = classifyMessage(message({
    body: '요청하신 견적서를 전달 드립니다. 확인 부탁드립니다.',
    isOutgoing: true,
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('일반 인증번호는 low reference이고 업무 세금계산서 확인은 normal reference다', () => {
  const verification = classifyMessage(message({
    subject: 'Email verification',
    body: 'Verification code for account: 061698',
  }));
  assert.equal(verification.workState, 'reference');
  assert.equal(verification.nextActor, 'none');
  assert.equal(verification.priority, 'low');

  const invoice = classifyMessage(message({
    subject: '세금계산서를 확인했습니다',
    body: '전자 세금계산서를 확인했습니다. 품목: 라이선스, 공급가액: 2,800,000원',
  }));
  assert.equal(invoice.workState, 'reference');
  assert.equal(invoice.nextActor, 'none');
  assert.equal(invoice.priority, 'normal');
});

test('보안 장비의 인증 Alert는 확인 전까지 review_required/high다', () => {
  const result = classifyMessage(message({
    subject: 'Alert Message from Sangfor Appliance',
    body: 'Verification code for account blro: 061698',
  }));
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'high');
  assert.equal(result.evidence.workState.rule, 'security-verification-alert-review');
});

test('영문 기술 지원 요청은 important action으로 놓치지 않는다', () => {
  const result = classifyMessage(message({
    subject: 'SASE DNS mapping support',
    body: 'Is it possible to configure DNS mapping? Please answer and support remote is best.',
  }));
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.match(result.evidence.workState.exactText, /possible|Please answer/i);
});

test('삭제·정크 폴더 메일은 현재 업무로 재등장하지 않는다', () => {
  const deleted = classifyMessage(message({ body: '내일까지 견적서를 보내주세요.', isDeletedFolder: true }));
  const junk = classifyMessage(message({ body: '긴급 승인 부탁드립니다.', isJunkFolder: true }));
  assert.equal(deleted.workState, 'reference');
  assert.equal(junk.workState, 'reference');
});

test('삭제 폴더의 입찰 마감·장애 사건도 semantic event보다 lifecycle 정책이 우선한다', () => {
  const procurement = classifyMessage(message({
    subject: '입찰 0일 후 마감',
    body: '오늘 마감이므로 기한 내 응찰 바랍니다.',
    isDeletedFolder: true,
  }));
  const incident = classifyMessage(message({
    subject: '긴급 GPU 장애',
    body: 'GPU 노드가 offline 상태이며 알람이 반복됩니다. 즉시 조치 바랍니다.',
    isJunkFolder: true,
  }));
  for (const result of [procurement, incident]) {
    assert.equal(result.workState, 'reference');
    assert.equal(result.nextActor, 'none');
    assert.equal(result.priority, 'low');
    assert.equal(result.dueAt, null);
  }
});

test('수신 메일의 호칭에 대표가 있어도 요청 주체를 내부 팀으로 오인하지 않는다', () => {
  const result = classifyMessage(message({
    body: '박재민대표님! 갱신 견적 보내드리오니 확인 부탁드립니다.',
  }));
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
});


test('FAQ와 표 안의 요청조회·장애 문구가 실제 요청 근거와 기한·보안 신호를 오염시키지 않는다', () => {
  const input = message({
    subject: '세금계산서 발행 요청의 건',
    body: [
      '안녕하세요 담당자님,',
      '하기 내용 검토하시어 문제가 없으시다면, 세금계산서 발행 부탁드립니다.',
      '계약기간 2026-02-01 ~ 2027-01-31',
      'FAQ',
      '전자계약서 조회 경로 - 발주관리 > 발주(계약)접수요청조회',
      '점검/장애 지원 내역이 없는 경우 문구를 작성합니다.',
    ].join('\n'),
  });
  const result = classifyMessage(input, { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.match(result.evidence.workState.exactText, /세금계산서 발행 부탁드립니다/);
  assert.doesNotMatch(result.evidence.workState.exactText, /접수요청조회/);
  assert.equal(result.dueAt, null);
  assert.equal(result.duePrecision, 'none');
  assert.equal(result.signals.includes('incident_security'), false);
  assert.equal(result.priority, 'normal');
});

test('계약기간은 due가 아니지만 실제 만료·마감 문맥은 due로 유지한다', () => {
  const periodOnly = classifyMessage(message({
    body: '자료 검토 부탁드립니다. 계약기간 2026-02-01 ~ 2027-01-31',
  }), { now: new Date(receivedAt) });
  assert.equal(periodOnly.dueAt, null);

  const expiry = classifyMessage(message({
    subject: '라이선스 2026-10-13 만료',
    body: '갱신 견적서를 보내주세요.',
  }), { now: new Date(receivedAt) });
  assert.equal(expiry.duePrecision, 'date');
  assert.match(expiry.dueText, /2026-10-13/);
});


test('자동 세금계산서 도착·조회 안내는 UI 클릭 문구가 있어도 reference다', () => {
  const result = classifyMessage(message({
    subject: '한국정보인증에서 세금계산서가 발행되었습니다.',
    body: '세금계산서가 발행되었습니다. 아래 주소를 클릭하시어 세금계산서조회 기능을 이용하여 주시기 바랍니다.',
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');

  const realRequest = classifyMessage(message({
    subject: '세금계산서 발행 요청의 건',
    body: '세금계산서 발행 부탁드립니다.',
  }));
  assert.equal(realRequest.workState, 'action_required');
});

test('회신 제목의 과거 요청과 기밀 고지는 현재 action 근거가 아니다', () => {
  const result = classifyMessage(message({
    subject: 'Re: 발주서 제출 요청',
    body: 'If you receive this email by mistake, please delete it and notify the sender immediately.',
  }));
  assert.notEqual(result.workState, 'action_required');
  assert.doesNotMatch(result.evidence.workState?.exactText || '', /please delete/i);
});

test('과거 요청을 설명하는 전달 메일은 과거 표현을 현재 요청으로 승격하지 않는다', () => {
  const result = classifyMessage(message({
    subject: 'FW: 라이선스 현황표 전달',
    body: '장비 현황표를 전달 드립니다. 노란색 항목은 이전에 요청 했던 갱신 대상들입니다.',
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.match(result.evidence.workState.exactText, /전달 드립니다/);
});

test('완료·참고 메일은 장애 단어가 있어도 critical이 아니다', () => {
  const result = classifyMessage(message({
    subject: '장비 정보 전달',
    body: '장비 정보 직접 전달 드립니다. 과거 장애 지원 내역도 포함했습니다.',
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.priority, 'normal');
  assert.notEqual(result.priority, 'critical');
});

test('현재 문장 없이 전달된 메일은 reference로 남는다', () => {
  const result = classifyMessage(message({
    subject: 'Fwd: 작업 리포트 전달드립니다.',
    body: 'Android용 Outlook 다운로드\n\n---------- Forwarded message ----------\n작업 리포트입니다.',
    hasAttachments: true,
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
});


test('보낸 편지함의 실질 본문은 명시적 종결어가 없어도 외부 반응 대기로 둔다', () => {
  const result = classifyMessage(message({
    subject: 'Re: 서버 견적 요청 건',
    body: '고객사에서 긴급 견적 요청을 받았습니다. 변경 사양과 수량은 아래와 같습니다.',
    isOutgoing: true,
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.reviewStatus, 'auto');
});

test('sent-folder sender alias makes custom-folder requests WAITING / EXTERNAL_PARTY', () => {
  const result = classifyMessage(message({
    subject: '발주 요청',
    from: 'owner@example.com',
    body: '라이선스 발주 부탁드립니다.',
    folderName: '발주 to 파트너',
  }), {
    mailboxAddress: 'me',
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('substantive outbound draft is treated as queued external work', () => {
  const result = classifyMessage(message({
    subject: '발주 요청 초안',
    from: 'owner@example.com',
    body: '라이선스 발주 부탁드립니다.',
    isDraft: true,
    isDraftFolder: true,
  }), {
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'queued-outbound-request');
});

test('구체적인 질문과 발주 요청이 함께 있는 Draft도 현재 나의 Action이 아니라 발송 대기 업무다', () => {
  const result = classifyMessage(message({
    subject: '라이선스 발주 정보 확인 요청',
    body: '시리얼 번호가 맞는지 확인 가능할까요? 확인 후 라이선스 발주 부탁드립니다.',
    isDraft: true,
    isDraftFolder: true,
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.priority, 'normal');
  assert.match(result.evidence.workState.rule, /queued-outbound-request/);
});

test('견적 전달 후 확인 요청이 있는 Draft를 수신 검토 업무로 오인하지 않는다', () => {
  const result = classifyMessage(message({
    subject: '서버 견적서 전달 초안',
    body: '요청하신 서버 견적서를 첨부드립니다. 확인 부탁드립니다.',
    hasAttachments: true,
    isDraft: true,
    isDraftFolder: true,
  }));
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'queued-outbound-request');
});

test('empty draft remains review_required instead of being silently discarded', () => {
  const result = classifyMessage(message({
    subject: '',
    body: '',
    isDraft: true,
    isDraftFolder: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState, null);
});

test('greeting-only draft remains review_required because it is incomplete', () => {
  const result = classifyMessage(message({
    subject: '[',
    body: '안녕하세요\n베를로 박재민입니다.',
    isDraft: true,
    isDraftFolder: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'greeting-only-draft-review');
});

test('incoming quote delivery without a new request remains REVIEW_REQUIRED / UNKNOWN', () => {
  const result = classifyMessage(message({
    subject: '[파트너] Renewal 재견적',
    body: '본사 확인받아 Renewal 재견적 보내드립니다. 추가 DC를 반영했습니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.match(result.evidence.workState.exactText, /재견적 보내드립니다/);
});

test('automated document final-completion notice is COMPLETED rather than Reference', () => {
  const result = classifyMessage(message({
    subject: '[전자서명] \'계약문서\' 문서가 완료되었습니다.',
    from: 'noreply@eformsign.com',
    body: '문서가 최종 완료되었습니다. 완료 문서 보기',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.evidence.priority.rule, 'automated-completion-low');
});

test('completion event is not overridden by request-shaped workflow nouns', () => {
  const result = classifyMessage(message({
    subject: '검수요청 승인 결과',
    body: '발주 계약 건으로 검수요청 승인이 완료 되었습니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});

test('incoming request for another email address or contact remains actionable', () => {
  const result = classifyMessage(message({
    subject: '메일 차단 관련',
    body: '양해광 상무님께 메일을 보냈는데 차단되었습니다. 다른 메일이나 연락처 부탁드립니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
});

test('outgoing greeting-only message is review_required rather than a fake waiting task', () => {
  const result = classifyMessage(message({
    subject: '',
    body: '안녕하세요 베를로 박재민입니다. 감사합니다.',
    from: 'owner@example.com',
    isOutgoing: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
});

test('promotional and automatic references stay low while business references remain normal', () => {
  const promotional = classifyMessage(message({
    subject: 'Newsletter',
    body: 'Newsletter update. unsubscribe',
    isPromotional: true,
  }));
  assert.equal(promotional.workState, 'reference');
  assert.equal(promotional.priority, 'low');

  const business = classifyMessage(message({
    subject: '장비 정보 참고',
    body: '장비 정보입니다. 참고 바랍니다.',
  }));
  assert.equal(business.workState, 'reference');
  assert.equal(business.priority, 'normal');
});

test('Ecount purchase-order notice requires review but never becomes a direct action', () => {
  const result = classifyMessage(message({
    subject: '발주서 첨부드립니다.',
    body: '[일에이엔]님이 보낸 발주서입니다. 수신문서보기 버튼을 클릭하시기 바랍니다. 향후 본 내용이 없는 메일은 이카운트에서 보낸 메일이 아닙니다. EFFICIENT CHANGE!',
    from: 'sendmail@ecount.com',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.match(result.evidence.workState.exactText, /발주서|수신문서보기|이카운트/);
});

test('thread content-normalization update without a direct request is a business Reference', () => {
  const result = classifyMessage(message({
    subject: 'RE: 라이선스 정보 확인',
    body: '내용 혼선 방지 위해 본문 메일에 수정 게시 합니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});

test('incoming inline color-coded thread response requires owner review', () => {
  const result = classifyMessage(message({
    subject: 'RE: 라이선스 정보 확인 요청',
    body: '내용 혼선 방지 위해 본문 메일에 수정 게시 합니다. (아래, 파란색)',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'incoming-inline-response-update');
});

test('outgoing proposal delivery with only a conditional future offer is COMPLETED', () => {
  const result = classifyMessage(message({
    subject: 'Re: 보안 컨설팅 제안',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '전달해주신 항목 기반으로 제안서를 정리했습니다. 추가로 필요하신 자료는 요청해주시면 전달드리겠습니다.',
  }), {
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'outgoing-delivery-completed');
});

test('outgoing contact delivery without a recipient request is COMPLETED', () => {
  const result = classifyMessage(message({
    subject: 'Re: 담당자 연락처',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '아래와 같이 연락처 전달 드립니다. 담당자: 홍길동, 이메일: contact@example.com',
  }), {
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});

test('incoming document delivery followed by a standalone review request remains actionable', () => {
  const result = classifyMessage(message({
    subject: 'Fwd: 발주서 첨부드립니다.',
    body: '코원에너지서비스 건 발주서를 송부드립니다. 확인 부탁드리겠습니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.match(result.evidence.workState.exactText, /확인 부탁드리겠습니다/);
});

test('전달 제목의 장비·라이선스 현황표는 완료 업무가 아니라 정보성 reference다', () => {
  const result = classifyMessage(message({
    subject: 'FW: 고객사 장비 라이센스 현황표 전달 드립니다.',
    body: '요청하신 현황표를 전달드립니다. 추가 문의가 있으시면 연락 부탁드립니다.',
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.ok(['subject', 'body'].includes(result.evidence.workState.sourceField));
  assert.match(result.evidence.workState.exactText, /현황표|장비\s*정보|라이센스\s*현황/);
  assert.match(result.evidence.workState.rule, /informational-asset-reference/);
});

test('현재 제목과 본문에 직접 파일 요청이 있으면 전달 표현이 함께 있어도 action을 보존한다', () => {
  const result = classifyMessage(message({
    subject: 'IAG 라이선스 갱신을 위한 info 파일 요청',
    body: '기존 자료를 전달드리오니 확인 후 갱신용 info 파일을 보내주시기 바랍니다.',
  }));
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('긴급 제목의 현재 견적 후속 요청은 semantic event의 기본값에 눌리지 않고 high다', () => {
  const result = classifyMessage(message({
    subject: '[긴급] 고객사 견적 요청드립니다.',
    body: '구성 정보를 전달드리오니 견적서를 회신 부탁드립니다.',
  }));
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'high');
  assert.match(result.evidence.priority.exactText, /긴급/);
});

test('multiple explicit business actions stay normal without verified urgency', () => {
  const result = classifyMessage(message({
    subject: '발주 및 계약 검토 요청',
    body: '라이선스 발주 요청드립니다. 세금계산서를 발행해주시기 바랍니다. 공급계약서 검토 부탁드립니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.priority.rule, 'multiple-actions-without-urgency');
});

test('two related requests without urgency remain normal priority', () => {
  const result = classifyMessage(message({
    subject: '기술 문의',
    body: 'DNS mapping이 가능한지 확인 부탁드립니다. 원격 지원 가능 여부도 답변 부탁드립니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('support ticket closure wins over conditional contact boilerplate', () => {
  const result = classifyMessage(message({
    subject: 'RE: Kernel patch issue [Ticket#20260831860001]',
    body: 'The issue has been resolved, so we will proceed to close this ticket. Should you have any further inquiries, please reply to our email.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'support-ticket-completed');
});

test('support schedule confirmation is external waiting, not a reply action', () => {
  const result = classifyMessage(message({
    subject: 'RE: Remote support [Ticket#20260831860002]',
    body: 'Surely, let\'s make it tomorrow morning 11am GMT+9. Should you have any further inquiries, please reply to our email.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'support-schedule-confirmed');
});

test('automated card statement footer does not create an action', () => {
  const result = classifyMessage(message({
    subject: '[카드사] 법인카드 8월 이용대금 명세서 입니다.',
    body: '이번 달 이용대금 명세서입니다. 문의는 고객센터로 연락하시기 바랍니다.',
    hasAttachments: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.evidence.workState.rule, 'low-value-automated-reference');
});

test('insurance policy delivery with contact footer remains a low reference', () => {
  const result = classifyMessage(message({
    subject: '[보험사] 보험증권 송부',
    body: '보험증권과 청약서류를 보내드립니다. 추가 문의는 콜센터로 연락주시기 바랍니다.',
    hasAttachments: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
});

test('direct technical inquiry overrides an informational delivery phrase', () => {
  const result = classifyMessage(message({
    subject: 'VPN 호환성 문의',
    body: '관련 내용을 미리 여쭙고자 보내드립니다. 해당 VDI를 애플 제품으로 접속 가능한지 문의드립니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'incoming-direct-inquiry');
});

test('service deactivation notice remains actionable despite an automated sender', () => {
  const result = classifyMessage(message({
    subject: 'Your project subscription is being deactivated due to inactivity',
    body: 'Your subscription will be deactivated soon unless activity resumes.',
    from: 'notification@example.com',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'service-deactivation-action');
});

test('marketing unsubscribe language never becomes a service deactivation action', () => {
  const result = classifyMessage(message({
    subject: '숙박을 평가하고 할인 혜택을 받아보세요',
    body: '이용후기를 작성해 주세요. 수신을 거부할 수 있으며 그렇게 될 경우 마케팅 관련 이메일 구독 또한 해지됩니다.',
    from: 'no-reply@example.com',
    isPromotional: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
});

test('successful subscription renewal is completed', () => {
  const result = classifyMessage(message({
    subject: 'Business subscription renewed',
    body: 'Your subscription was successfully renewed. The saved payment method was charged.',
    from: 'billing@example.com',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'subscription-renewal-completed');
});

test('received electronic tax invoice requires review even when marked promotional', () => {
  const result = classifyMessage(message({
    subject: '전자세금계산서 발급 메일 안내',
    body: '공급 사업자가 귀사에 전자세금계산서를 발급하고 발송한 메일입니다.',
    isPromotional: true,
    folderName: '세금계산서',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'received-tax-invoice-review');
});

test('invoice ready notice requires review', () => {
  const result = classifyMessage(message({
    subject: '청구서 G1234가 준비되었습니다',
    body: '최신 청구서를 검토할 준비가 되었습니다. 청구서를 보려면 로그인하세요.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'invoice-ready-review');
});

test('deleted greeting-only draft is a low lifecycle reference', () => {
  const result = classifyMessage(message({
    subject: '',
    body: '안녕하세요 베를로 박재민입니다.',
    isDraft: true,
    isDraftFolder: true,
    isDeletedFolder: true,
    receivedAt: '2026-08-01T00:00:00.000Z',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.evidence.workState.rule, 'aged-deleted-draft-reference');
});

test('recent deleted incomplete draft remains reviewable', () => {
  const result = classifyMessage(message({
    subject: '',
    body: '안녕하세요 베를로 박재민입니다.',
    isDraft: true,
    isDraftFolder: true,
    isDeletedFolder: true,
    receivedAt: '2026-08-28T00:00:00.000Z',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'review_required');
  assert.equal(result.nextActor, 'unknown');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'deleted-greeting-draft-review');
});

test('attachment-only filename with tracking pixel is a low reference', () => {
  const result = classifyMessage(message({
    subject: 'company-logo.ai',
    body: '[https://mail.example.com/readReceipt/notify.gif]',
    hasAttachments: true,
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.evidence.workState.rule, 'attachment-only-reference');
});

test('첨부를 약속했지만 실제 첨부가 없고 회신 불필요인 메일은 완료가 아니라 reference다', () => {
  const result = classifyMessage(message({
    subject: '견적서 전달',
    body: '견적서를 첨부드립니다. 별도 회신은 필요 없습니다.',
    hasAttachments: false,
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.ok(result.signals.includes('attachment'));
  assert.ok(result.signals.includes('attachment_missing'));
});

test('outgoing substantive answer is completed rather than external waiting', () => {
  const result = classifyMessage(message({
    subject: 'Re: 기술 구성 문의',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '확인 요청하신 사항에 대해서 아래와 같이 답변드립니다. 첫 번째 방식은 지원되지 않으며 두 번째 구성을 권장합니다.',
  }), {
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'outgoing-substantive-response-completed');
});

test('approval workflow context remains an action when the user must register and reply', () => {
  const result = classifyMessage(message({
    subject: '구매포탈 업체 등록 요청',
    body: '계약 진행을 위하여 구매포탈 내 업체 등록을 요청드립니다. 계정 생성 후 승인 처리를 위해 메일 회신 부탁드립니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('old due date does not make a historical action high priority', () => {
  const result = classifyMessage(message({
    subject: '서버 반입 승인 요청',
    body: '2026-02-10 오전 11시까지 서버 반입 승인을 요청드립니다.',
    receivedAt: '2026-02-03T00:00:00.000Z',
  }), { now: new Date('2026-08-31T00:00:00.000Z') });
  assert.equal(result.workState, 'decision_required');
  assert.equal(result.priority, 'normal');
});

test('completed outbound delivery preserves explicit urgent thread priority', () => {
  const result = classifyMessage(message({
    subject: 'Re: [긴급] 견적 요청',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '요청하신 견적서를 파일로 전달 드립니다.',
    hasAttachments: true,
  }), {
    mailboxAddresses: ['owner@example.com'],
    now: new Date(receivedAt),
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.priority.rule, 'completed-business-context');
});

test('access information delivery with conditional contact text remains a business reference', () => {
  const result = classifyMessage(message({
    subject: 'HCI 접속 정보 전달',
    body: 'VPN 설치 파일과 접속 방법 다운로드 링크를 전달드립니다. 추가 필요한 사항 있으실 경우 회신 혹은 유선 연락 부탁드립니다.\n--------------------\n본 메일이 잘못 전송된 경우 삭제하여 주시기 바랍니다.',
  }), { now: new Date(receivedAt) });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});

test('수신자가 요청을 잘 전달받았다는 확인과 조건부 도움 제안만 보내면 completed다', () => {
  const result = classifyMessage(message({
    subject: 'RE: 구축 지원 요청',
    body: '요청하신 사항은 잘 전달 받았습니다. 추가 지원이 필요하시면 언제든 연락 부탁드립니다.',
  }));
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'inbound-acknowledgement-completed');
});

test('서비스 비활성화 예정은 Action이지만 명시적 즉시 기한이 없으면 normal이다', () => {
  const result = classifyMessage(message({
    subject: '[Action Required] Your workspace subscription will be deactivated soon',
    body: 'Sign in to keep the workspace active.',
    from: 'notification@example.com',
  }));
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('세무 총정리·가이드 메일의 D-day와 질문형 본문은 개인 업무를 만들지 않는다', () => {
  const result = classifyMessage(message({
    subject: '8월, 법인세 중간예납 D-7 확인 사항 총정리',
    body: '신고 대상인지 궁금하신가요? 핵심 확인 사항을 정리했습니다.',
  }));
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
  assert.equal(result.dueAt, null);
});

test('수신 견적서 전달은 완료가 아니라 검토 필요이며 후속 요청이 있으면 Action이다', () => {
  const review = classifyMessage(message({
    subject: 'RE: 고객사 서버 견적 요청 건',
    body: '요청하신 서버 견적서를 첨부드립니다.',
    hasAttachments: true,
  }));
  assert.equal(review.workState, 'review_required');
  assert.equal(review.nextActor, 'unknown');

  const action = classifyMessage(message({
    subject: 'RE: 고객사 서버 견적 요청 건',
    body: '요청하신 서버 견적서를 첨부드립니다. 오늘까지 검토 후 회신 부탁드립니다.',
    hasAttachments: true,
  }));
  assert.equal(action.workState, 'action_required');
  assert.equal(action.nextActor, 'me');
});

test('견적과 함께 기술 제약·기능 설명·데이터시트를 전달하고 후속 요청이 없으면 completed다', () => {
  const result = classifyMessage(message({
    subject: '회신: HCI 구성용 서버 및 스위치 견적 요청',
    body: '요청하신 견적서 전달 드립니다. 설치 비용은 현장 상황에 따라 별도 산정합니다. 스위치는 Stacking 대신 MLAG 기능을 지원합니다. 데이터 시트를 첨부하였으니 참고하세요. 궁금하신 사항은 연락 바랍니다.',
    hasAttachments: true,
  }));
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.equal(result.evidence.workState.rule, 'inbound-substantive-fulfillment-completed');
});

test('구매 포털의 검수 승인 완료 알림은 저가치 reference가 아니라 completed business record다', () => {
  const result = classifyMessage(message({
    subject: '[구매포탈] 검수요청승인 처리 완료',
    body: '검수 요청 승인이 완료되었습니다.',
    from: 'portal@example.com',
  }));
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});


test('cycle03 current-content relationship controls exclude quoted requests and preserve inbound ownership', () => {
  const quotedOnly = classifyMessage(message({
    subject: 'Re: Commercial document',
    isOutgoing: true,
    hasAttachments: true,
    body: ['The document is attached.', '', '-----Original Message-----', 'Please confirm approval.'].join('\n'),
  }), { now: new Date(receivedAt) });
  assert.equal(quotedOnly.workState, 'completed');
  assert.equal(quotedOnly.nextActor, 'none');
  assert.equal(quotedOnly.priority, 'normal');

  const inbound = classifyMessage(message({
    body: 'Please update the contract document.',
  }), { now: new Date(receivedAt) });
  assert.equal(inbound.workState, 'action_required');
  assert.equal(inbound.nextActor, 'me');
  assert.equal(inbound.priority, 'normal');
});

test('cycle03 priority accepts current tomorrow evidence but rejects importance-only evidence', () => {
  const tomorrow = classifyMessage(message({
    body: 'Please update the contract document by tomorrow.',
  }), { now: new Date(receivedAt) });
  assert.equal(tomorrow.priority, 'high');

  const importanceOnly = classifyMessage(message({
    subject: 'Business reference',
    body: 'FYI: information is provided for reference.',
    importance: 'high',
  }), { now: new Date(receivedAt) });
  assert.equal(importanceOnly.workState, 'reference');
  assert.equal(importanceOnly.priority, 'normal');
});
