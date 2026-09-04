import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decisionFromMailEventFrame,
  extractMailEventFrame,
  isPriorityBoilerplate,
  MAIL_EVENT_FRAME_VERSION,
} from '../src/domain/mail-event-extractor.js';

function clause(text, sourceField = 'body', startOffset = 0) {
  return {
    text,
    exactText: text,
    sourceField,
    sourceMessageId: 'event-test',
    start: startOffset,
    end: startOffset + text.length,
    startOffset,
    endOffset: startOffset + text.length,
    sourceText: text,
  };
}

function frame({ subject = '', body = '', message = {}, baseState = { workState: 'review_required' } } = {}) {
  const clauses = [];
  if (subject) clauses.push(clause(subject, 'subject'));
  if (body) clauses.push(clause(body, 'body'));
  return extractMailEventFrame({
    message: { id: 'event-test', subject, ...message },
    clauses,
    currentText: [subject, body].filter(Boolean).join('\n'),
    baseState,
  });
}

function decision(input) {
  return decisionFromMailEventFrame(frame(input));
}

test('event frame exposes a stable version and one primary semantic event', () => {
  const result = frame({
    subject: '[Action Required] Workspace subscription is currently inactive',
    body: 'Sign in to keep your subscription active.',
  });
  assert.equal(result.version, MAIL_EVENT_FRAME_VERSION);
  assert.equal(result.primaryEvent.type, 'service_continuity_action');
  assert.equal(result.primaryEvent.decision.workState, 'action_required');
});

test('marketing unsubscribe language is not a service continuity action', () => {
  const result = frame({
    subject: 'Marketing newsletter',
    body: 'Your marketing subscription will be deactivated when you unsubscribe.',
    message: { isPromotional: true },
  });
  assert.notEqual(result.primaryEvent?.type, 'service_continuity_action');
});

test('support close approval beats generic resolved wording', () => {
  const result = decision({
    subject: 'Support Ticket#20260001',
    body: 'May I know if the issue has been resolved? We would like to seek your approval to close this support ticket.',
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.nextActorHint, 'me');
  assert.equal(result.eventType, 'support_close_approval');
});

test('R1 support availability question today is a high owner action, except closed tickets', () => {
  const actionable = decision({
    subject: 'Support Ticket#20260011',
    body: 'May we join a remote session tomorrow? Is your support team available?',
  });
  assert.equal(actionable.workState, 'action_required');
  assert.equal(actionable.nextActorHint, 'me');
  assert.equal(actionable.priorityHint, 'high');
  assert.equal(actionable.eventType, 'support_remote_availability_action');

  const closed = decision({
    subject: 'Support Ticket#20260012',
    body: 'The issue is resolved and the ticket is closed. Can you join remotely tomorrow?',
  });
  assert.equal(closed.workState, 'completed');
  assert.equal(closed.eventType, 'support_resolved');
});

test('R2 invitation accept/open/review is an owner action and excludes promotional variants', () => {
  const actionable = decision({
    subject: 'Project invitation',
    body: 'You are invited to a shared workspace. Please accept and review the project.',
  });
  assert.equal(actionable.workState, 'action_required');
  assert.equal(actionable.nextActorHint, 'me');
  assert.equal(actionable.priorityHint, 'normal');
  assert.equal(actionable.eventType, 'incoming_collaboration_invite_action');

  const koreanActionable = decision({
    subject: 'Action needed: workspace invitation',
    body: '액션 필요: Notion workspace에 초대했습니다.',
  });
  assert.equal(koreanActionable.eventType, 'incoming_collaboration_invite_action');

  const promotional = decision({
    subject: 'Webinar invitation',
    body: 'You are invited to our webinar. Accept the promotional invitation or unsubscribe.',
    message: { isPromotional: true },
  });
  assert.notEqual(promotional.eventType, 'incoming_collaboration_invite_action');

  const passiveInvite = decision({
    subject: 'Project invitation',
    body: 'You are invited to a shared workspace to review project updates.',
  });
  assert.notEqual(passiveInvite?.eventType, 'incoming_collaboration_invite_action');
});

test('R4 outgoing attached commercial quote awaits explicit recipient review or reply', () => {
  const waiting = decision({
    subject: 'Commercial quotation',
    body: 'The quotation is attached. Please review and reply with your acceptance.',
    message: { isOutgoing: true, hasAttachments: true },
  });
  assert.equal(waiting.workState, 'waiting');
  assert.equal(waiting.nextActorHint, 'external_party');
  assert.equal(waiting.eventType, 'outgoing_commercial_quote_delivery_waiting');

  const deliveryOnly = decision({
    subject: 'Commercial quotation',
    body: 'The quotation is attached for your records.',
    message: { isOutgoing: true, hasAttachments: true },
  });
  assert.equal(deliveryOnly.workState, 'completed');
  assert.equal(deliveryOnly.nextActorHint, 'none');

  const replyDelivery = decision({
    subject: 'Re: Commercial quotation request',
    body: 'The quotation is attached for your records.',
    message: { isOutgoing: true, hasAttachments: true },
  });
  assert.equal(replyDelivery.workState, 'completed');
  assert.equal(replyDelivery.nextActorHint, 'none');

  const conditional = decision({
    subject: 'Commercial quotation',
    body: 'If you need a quotation, let us know and we will provide one.',
    message: { isOutgoing: true, hasAttachments: true },
  });
  assert.notEqual(conditional?.eventType, 'outgoing_commercial_quote_delivery_waiting');
});

test('support resolution and patch delivery become completed events', () => {
  const resolved = decision({
    subject: 'Ticket#20260002',
    body: 'The patch files are good to work now. You can close ticket.',
  });
  assert.equal(resolved.workState, 'completed');
  assert.equal(resolved.eventType, 'support_resolved');

  const delivered = decision({
    subject: 'Ticket#20260003',
    body: 'We have attached the required two VM kernel patch files on this email.',
  });
  assert.equal(delivered.workState, 'completed');
  assert.equal(delivered.eventType, 'support_artifact_delivered');
});

test('service continuity, card limit, subscription follow-up and shared access are actions', () => {
  const samples = [
    {
      subject: '[Action Required] Your subscription is currently inactive',
      body: 'Jump back in to keep your subscription.',
      type: 'service_continuity_action',
      priority: 'normal',
    },
    {
      subject: '카드 한도 초과 예상',
      body: '한도 소진율이 80% 이상으로 초과가 예상됩니다. 선결제를 진행하여 결제 실패를 막아보세요.',
      type: 'financial_limit_risk_action',
      priority: 'normal',
    },
    {
      subject: '구독 한도 심사 완료 안내',
      body: '구독 서비스 한도 산출이 완료되었습니다. 지금 바로 구독 신청하기.',
      type: 'subscription_followup_action',
      priority: 'normal',
    },
    {
      subject: 'Folder shared with you',
      body: 'A project folder was shared with you. Verify your email to securely view this shared folder.',
      type: 'shared_access_verification',
      priority: 'normal',
    },
  ];

  for (const sample of samples) {
    const result = decision(sample);
    assert.equal(result.workState, 'action_required', sample.type);
    assert.equal(result.nextActorHint, 'me', sample.type);
    assert.equal(result.priorityHint, sample.priority, sample.type);
    assert.equal(result.eventType, sample.type);
  }
});

test('completed workflow beats request-shaped nouns in the same sentence', () => {
  const result = decision({
    subject: '검수요청 승인 결과',
    body: '발주 계약 건으로 검수요청 승인이 완료 되었습니다.',
  });
  assert.equal(result.workState, 'completed');
  assert.equal(result.eventType, 'business_process_completed');
});

test('automatic invoice and archived tax-invoice notices are low references', () => {
  const invoice = decision({
    subject: '청구서 G100이 준비되었습니다',
    body: '청구서를 보려면 로그인하세요. 이미 결제한 경우 무시하세요. 카드가 자동으로 청구됩니다.',
    message: { folderName: '세금계산서', from: 'billing@service.example' },
  });
  assert.equal(invoice.workState, 'reference');
  assert.equal(invoice.priorityHint, 'low');
  assert.equal(invoice.eventType, 'automated_invoice_reference');

  const taxInvoice = decision({
    subject: '전자세금계산서 발급 메일 안내',
    body: '사업자가 거래처에게 전자세금계산서를 발급하고 발송한 메일입니다.',
    message: { folderName: '세금계산서' },
  });
  assert.equal(taxInvoice.workState, 'reference');
  assert.equal(taxInvoice.priorityHint, 'low');
  assert.equal(taxInvoice.eventType, 'archived_tax_invoice_reference');
});

test('subject-only bulk routing notice does not create a personal task', () => {
  const result = decision({
    subject: '세금계산서 발행 및 검수확인서 제출 요청',
    body: '수신: 협력사 제위 발신: 구매팀',
  });
  assert.equal(result.workState, 'reference');
  assert.equal(result.priorityHint, 'low');
  assert.equal(result.eventType, 'bulk_subject_notice_reference');
});

test('outgoing delivery distinguishes recipient follow-up from completed fulfillment', () => {
  const waiting = decision({
    subject: '견적 및 제안자료 회신',
    body: '요청하신 견적서와 제안서를 전달 드립니다. 기타 필요서류 확인해주시면 준비해서 전달 드리겠습니다.',
    message: { isOutgoing: true },
  });
  assert.equal(waiting.workState, 'waiting');
  assert.equal(waiting.nextActorHint, 'external_party');

  const completed = decision({
    subject: '입찰 금액 기입',
    body: '입찰 참여 금액을 기입하였습니다. 이 부분 오해없이 검토 부탁드립니다.',
    message: { isOutgoing: true },
  });
  assert.equal(completed.workState, 'completed');
  assert.equal(completed.nextActorHint, 'none');
});

test('current urgency can raise an actionable base state without changing its state', () => {
  const result = decision({
    subject: '기술지원 요청',
    body: '빠른 조치 부탁드립니다. 금일 해결이 필요합니다.',
    baseState: { workState: 'action_required' },
  });
  assert.equal(result.workState, 'action_required');
  assert.equal(result.priorityHint, 'high');
  assert.equal(result.eventType, 'current_action_urgency');
});

test('legal disclaimer and conditional support footer are priority boilerplate', () => {
  assert.equal(isPriorityBoilerplate('본 전자우편이 잘못 전송된 경우 즉시 발신인에게 알린 후 파기하여 주시기 바랍니다.'), true);
  assert.equal(isPriorityBoilerplate('Should you have any further inquiries, please reply to our email.'), true);
  assert.equal(isPriorityBoilerplate('금일 장애를 해결해 주세요.'), false);
});


test('urgent security outage becomes critical while normal urgency remains high', () => {
  const result = decision({
    subject: '긴급 보안 장애',
    body: '긴급 보안 장애입니다. 즉시 접속 불가 원인을 확인해 주세요.',
    baseState: { workState: 'action_required' },
  });
  assert.equal(result.priorityHint, 'critical');
});

test('incoming support request is owner action unless an external support recipient owns the next step', () => {
  const incoming = frame({
    subject: 'Re: License issue [Ticket#20260701860005]',
    body: 'The license is invalid. Please clear the license information.',
    message: {
      from: 'customer@example.com',
      toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    },
  });
  assert.equal(incoming.primaryEvent.type, 'support_incoming_request_action');
  assert.equal(incoming.primaryEvent.decision.workState, 'action_required');
  assert.equal(incoming.primaryEvent.decision.nextActor, 'me');
  assert.equal(incoming.primaryEvent.decision.priority, 'high');

  const waiting = frame({
    subject: 'Re: License issue [Ticket#20260701860005]',
    body: 'The license is invalid. Please clear the license information.',
    message: {
      from: 'partner@example.com',
      toRecipients: [
        { emailAddress: { address: 'tech.support@example.com' } },
        { emailAddress: { address: 'owner@example.com' } },
      ],
    },
  });
  assert.equal(waiting.primaryEvent.type, 'support_provider_request_waiting');
  assert.equal(waiting.primaryEvent.decision.workState, 'waiting');
  assert.equal(waiting.primaryEvent.decision.nextActor, 'external_party');
});
