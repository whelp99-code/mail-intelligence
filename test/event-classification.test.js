import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyMessage } from '../src/domain/precision-classifier.js';

const now = new Date('2026-09-01T00:00:00.000Z');

function message(overrides = {}) {
  return {
    id: overrides.id || `event-${Math.random()}`,
    subject: overrides.subject || '업무 메일',
    from: overrides.from || 'sender@example.com',
    fromName: overrides.fromName || '담당자',
    receivedAt: overrides.receivedAt || '2026-09-01T00:00:00.000Z',
    body: overrides.body || '',
    bodyPreview: overrides.bodyPreview || overrides.body || '',
    importance: overrides.importance || 'normal',
    hasAttachments: Boolean(overrides.hasAttachments),
    isOutgoing: Boolean(overrides.isOutgoing),
    isPromotional: Boolean(overrides.isPromotional),
    isDraft: Boolean(overrides.isDraft),
    isDraftFolder: Boolean(overrides.isDraftFolder),
    isDeletedFolder: Boolean(overrides.isDeletedFolder),
    isJunkFolder: Boolean(overrides.isJunkFolder),
    ...overrides,
  };
}

function classify(overrides) {
  return classifyMessage(message(overrides), { now });
}

test('support ticket resolution ignores conditional contact footer', () => {
  const result = classify({
    subject: 'RE: Kernel patch issue [Ticket#20260901860001]',
    body: 'The issue has been resolved and we will proceed to close this ticket. Should you have any further inquiries, please reply to our email.',
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.match(result.evidence.workState.rule, /support[-_](?:completed|ticket)/);
});

test('support close approval remains an owner action', () => {
  const result = classify({
    subject: 'RE: Support case [Ticket#20260901860002]',
    body: 'The issue appears resolved. May we close this ticket? Please confirm whether we can close it.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('support schedule confirmation is external waiting', () => {
  const result = classify({
    subject: 'RE: Remote support [Ticket#20260901860003]',
    body: 'We will connect tomorrow at 11am GMT+9 for remote support. Should you have any further questions, contact us.',
  });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
  assert.equal(result.priority, 'normal');
});

test('support request for diagnostic logs remains actionable', () => {
  const result = classify({
    subject: 'RE: VPN issue [Ticket#20260901860004]',
    body: 'Please provide the diagnostic logs and a screenshot of the error.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
});

test('service deactivation warning is an action, not a reference notification', () => {
  const result = classify({
    subject: 'Confluence site scheduled for deactivation',
    from: 'notifications@example.com',
    body: 'Your workspace will be deactivated in 7 days. Sign in to continue using the service.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('marketing unsubscribe text never becomes service deactivation work', () => {
  const result = classify({
    subject: '숙박 후기를 남기고 할인 받으세요',
    from: 'no-reply@marketing.example.com',
    isPromotional: true,
    body: '후기를 작성하면 할인 혜택을 받을 수 있습니다. 구독을 해지하면 마케팅 이메일 또한 비활성화됩니다. unsubscribe',
  });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'low');
});

test('quota or card-limit risk is a high owner action', () => {
  const result = classify({
    subject: '법인카드 한도 초과 예상 안내',
    from: 'notification@card.example.com',
    body: '현재 사용액 기준으로 이번 주에 카드 한도 초과가 예상됩니다. 한도 조정이 필요합니다.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
  assert.equal(result.priority, 'normal');
});

test('new tax invoice arrival requires review while confirmation is reference', () => {
  const arrival = classify({
    subject: '전자세금계산서가 발급되었습니다',
    from: 'hometaxadmin@example.com',
    body: '귀사 앞으로 전자세금계산서가 발급되어 도착했습니다.',
  });
  assert.equal(arrival.workState, 'review_required');
  assert.equal(arrival.nextActor, 'unknown');
  assert.equal(arrival.priority, 'normal');

  const confirmation = classify({
    subject: '세금계산서를 확인했습니다',
    from: 'webmaster@billing.example.com',
    body: '전자 세금계산서를 확인했습니다. 시스템 발송 메시지입니다.',
  });
  assert.equal(confirmation.workState, 'reference');
  assert.equal(confirmation.nextActor, 'none');
});

test('outgoing delivery without recipient request is completed', () => {
  const result = classify({
    subject: '제안서 전달',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '요청하신 항목을 반영한 제안서를 첨부하여 전달드립니다.',
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
});

test('outgoing delivery with explicit recipient follow-up is waiting', () => {
  const result = classify({
    subject: '견적서 전달 및 확인 요청',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '견적서를 전달드립니다. 검토 후 회신 부탁드립니다.',
  });
  assert.equal(result.workState, 'waiting');
  assert.equal(result.nextActor, 'external_party');
});

test('outgoing substantive answer is completed despite conditional assistance footer', () => {
  const result = classify({
    subject: 'RE: 설정 문의 답변',
    from: 'owner@example.com',
    isOutgoing: true,
    body: '문의하신 설정 방법을 아래와 같이 답변드립니다. 추가 문의가 있으시면 연락 부탁드립니다.',
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.nextActor, 'none');
});

test('incoming technical question wins over informational delivery phrase', () => {
  const result = classify({
    subject: 'HCI 라이선스 구성 문의',
    body: '현재 구성 정보를 전달드립니다. HCI 라이선스를 이 방식으로 적용할 수 있는지 확인 부탁드립니다.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActor, 'me');
});

test('active outage is critical while access-information delivery is a normal reference', () => {
  const incident = classify({
    subject: '긴급 HCI 서비스 중단',
    body: '현재 HCI 서비스 장애가 발생하여 접속이 불가합니다. 즉시 확인 부탁드립니다.',
  });
  assert.equal(incident.workState, 'action_required');
  assert.equal(incident.nextActor, 'me');
  assert.equal(incident.priority, 'critical');

  const access = classify({
    subject: 'VPN 및 HCI 접속 정보 전달',
    body: 'VPN 설치 파일 다운로드 링크와 HCI 접속 계정 정보를 전달드립니다. 추가 필요한 사항이 있으면 연락 부탁드립니다.',
  });
  assert.equal(access.workState, 'reference');
  assert.equal(access.nextActor, 'none');
  assert.equal(access.priority, 'normal');
});

test('legal disclaimer cannot create action or urgency', () => {
  const result = classify({
    subject: '장비 정보 전달',
    body: '장비 현황표를 전달드립니다. 만약 본 메일이 잘못 전송된 경우 즉시 삭제하여 주시기 바랍니다.',
  });
  assert.equal(result.workState, 'reference');
  assert.equal(result.nextActor, 'none');
  assert.equal(result.priority, 'normal');
  assert.doesNotMatch(result.evidence.workState?.exactText || '', /즉시 삭제/);
});
