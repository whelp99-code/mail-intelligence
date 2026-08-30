import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPrecisionCorrection,
  classificationFingerprint,
  classifyMessage,
  extractDue,
  normalizePrecisionCorrection,
  resolveProject,
  stripQuotedHistory,
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

test('내가 보낸 요청은 외부 당사자의 다음 행동으로 판단한다', () => {
  const result = classifyMessage(message({
    from: 'me@example.com',
    fromName: '박재민',
    body: '고객 담당자님, 내일까지 정책표를 보내주세요.',
    isOutgoing: true,
  }), { mailboxAddress: 'me@example.com' });
  assert.equal(result.workState, 'action_required');
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
