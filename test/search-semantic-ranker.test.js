import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSemanticSearchResults,
  rerankSemanticSearchResults,
  semanticSearchIntent,
} from '../src/domain/search-semantic-ranker.js';

function result({ id, subject, body = '', workState = 'reference', signals = [] }) {
  return {
    message: { id, subject, body },
    classification: {
      workState,
      signals,
      evidence: {
        workState: {
          exactText: body || subject,
        },
      },
    },
  };
}

test('completed patch-ticket query keeps resolved patch tickets and drops unrelated invoices', () => {
  const input = [
    result({
      id: 'resolved-patch',
      subject: 'Kernel patch issue [Ticket#123]',
      body: 'The issue has been resolved and the ticket is closed.',
      workState: 'completed',
    }),
    result({
      id: 'invoice',
      subject: '패치 서비스 세금계산서',
      body: '전자세금계산서가 발급되었습니다.',
    }),
  ];
  const output = rerankSemanticSearchResults('완료된 패치 티켓', input);
  assert.deepEqual(output.map((item) => item.message.id), ['resolved-patch']);
});

test('HCI license incident query requires all three semantic dimensions', () => {
  const input = [
    result({
      id: 'hci-license-error',
      subject: 'HCI 라이선스 오류',
      body: 'HCI 클러스터에서 라이선스 적용 실패가 발생했습니다.',
      workState: 'action_required',
      signals: ['incident_security'],
    }),
    result({
      id: 'hci-info',
      subject: 'HCI 장비 정보',
      body: 'HCI 구성 정보를 전달드립니다.',
    }),
    result({
      id: 'license-invoice',
      subject: '라이선스 세금계산서',
      body: '청구서가 준비되었습니다.',
    }),
  ];
  const output = rerankSemanticSearchResults('HCI 라이선스 장애', input);
  assert.deepEqual(output.map((item) => item.message.id), ['hci-license-error']);
});

test('security search rejects invoice and insurance noise while retaining contextual VPN incidents', () => {
  const input = [
    result({
      id: 'vpn-incident',
      subject: 'VPN 접속 오류',
      body: 'VPN 접속이 실패하여 원격 업무가 중단되었습니다.',
      workState: 'action_required',
    }),
    result({
      id: 'security-alert',
      subject: '비정상 로그인 보안 경고',
      body: 'Unauthorized login activity was detected.',
      workState: 'review_required',
      signals: ['incident_security'],
    }),
    result({
      id: 'vpn-contract',
      subject: 'VPN 임대 계약 보험 증권',
      body: '보험 증권과 세금계산서를 전달드립니다.',
    }),
  ];
  const output = rerankSemanticSearchResults('보안', input);
  assert.deepEqual(output.map((item) => item.message.id), ['security-alert', 'vpn-incident']);
});

test('completed support requires completed support evidence in the same candidate', () => {
  const input = [
    result({
      id: 'completed-support',
      subject: 'Vendor support case completed',
      body: 'The support case has been resolved.',
      workState: 'completed',
    }),
    result({
      id: 'completed-unrelated',
      subject: 'Completed document delivery',
      body: 'The document was delivered.',
      workState: 'completed',
    }),
  ];
  const output = rerankSemanticSearchResults('완료된 지원 문의', input);
  assert.deepEqual(output.map((item) => item.message.id), ['completed-support']);
});

test('shared verification requires both shared asset and verification evidence', () => {
  const input = [
    result({ id: 'shared-verify', subject: 'Shared folder email verification', body: 'Please verify your email for the shared folder.' }),
    result({ id: 'shared-only', subject: 'Shared folder notice', body: 'A shared folder is available.' }),
  ];
  const output = rerankSemanticSearchResults('공유 폴더 이메일 인증', input);
  assert.deepEqual(output.map((item) => item.message.id), ['shared-verify']);
});

test('quotation-order progress rejects disconnected commercial evidence', () => {
  const input = [
    result({ id: 'quote-order-progress', subject: 'Quotation and purchase order progress', body: 'Please confirm the purchase order progress for this quotation.' }),
    result({ id: 'quote-only', subject: 'Quotation delivered', body: 'The quotation was sent.' }),
    result({ id: 'order-only', subject: 'Purchase order received', body: 'The purchase order was received.' }),
  ];
  const output = rerankSemanticSearchResults('견적 발주 진행 확인', input);
  assert.deepEqual(output.map((item) => item.message.id), ['quote-order-progress']);
});

test('invoice human review rejects automated invoice notifications', () => {
  const input = [
    result({ id: 'human-review', subject: 'Invoice review requested', body: 'A 담당자 검토 요청 is required for this invoice.' }),
    result({ id: 'invoice-issue-request', subject: 'Invoice split request', body: '세금계산서를 두 건으로 분할 발행 부탁드립니다.', workState: 'review_required' }),
    result({ id: 'automated-notice', subject: 'Automated invoice notification', body: 'This is an automated invoice notice.' }),
  ];
  const output = rerankSemanticSearchResults('세금계산서 담당자 검토', input);
  assert.deepEqual(output.map((item) => item.message.id), ['human-review', 'invoice-issue-request']);
});

test('completed-history follow-up needs a current external follow-up, not body-only history', () => {
  const input = [
    result({
      id: 'external-followup',
      subject: 'Completed contract: customer confirmation requested',
      body: 'The contract is completed; customer confirmation is requested.',
      workState: 'completed',
    }),
    {
      message: {
        id: 'quoted-history-only',
        subject: 'Contract archive',
        body: 'Archive notice.\n\n-----Original Message-----\nCompleted contract. Customer confirmation requested.',
        bodyPreview: 'Archive notice.',
      },
      classification: {
        workState: 'completed',
        evidence: { workState: { exactText: 'Archive notice.' } },
      },
    },
  ];
  const output = rerankSemanticSearchResults('완료 계약 고객 확인 요청', input);
  assert.deepEqual(output.map((item) => item.message.id), ['external-followup']);
});

test('action-oriented semantic results reject reply subjects and quoted raw previews', () => {
  const input = [
    {
      message: {
        id: 'reply-subject-only',
        subject: 'RE: Shared folder email verification',
        bodyPreview: 'Thanks for the update.',
      },
      classification: { workState: 'action_required', evidence: {} },
    },
    {
      message: {
        id: 'quoted-preview-only',
        subject: 'Status update',
        bodyPreview: 'No current request.\n\n-----Original Message-----\nShared folder email verification is required.',
      },
      classification: { workState: 'action_required', evidence: {} },
    },
    {
      message: {
        id: 'signature-only',
        subject: 'Status update',
        bodyPreview: 'No current request.\n\nBest regards,\nShared folder email verification is required.',
      },
      classification: { workState: 'action_required', evidence: {} },
    },
  ];
  assert.deepEqual(rerankSemanticSearchResults('공유 폴더 이메일 인증', input), []);
});

test('canonical full current body qualifies when the preview is generic', () => {
  const output = rerankSemanticSearchResults('공유 폴더 이메일 인증', [{
    message: {
      id: 'full-current-body',
      subject: 'Status update',
      bodyPreview: 'A message was received.',
      bodyText: 'A shared folder is available. Please complete email verification to access it.',
    },
    classification: { workState: 'action_required', evidence: {} },
  }]);
  assert.deepEqual(output.map((item) => item.message.id), ['full-current-body']);
});

test('domain evaluator owns coherent direct-result and no-safe-result decisions', () => {
  const direct = evaluateSemanticSearchResults('완료된 지원 문의', [
    result({ id: 'direct', subject: 'Support case update', body: 'The support case is completed.', workState: 'completed' }),
  ]);
  assert.deepEqual(direct.decision, { answerable: true, abstained: false, reason: 'direct_result' });
  assert.equal(direct.results.length, 1);

  const abstained = evaluateSemanticSearchResults('완료된 지원 문의', [
    result({ id: 'unsafe', subject: 'Support archive', body: 'No current update.' }),
  ]);
  assert.deepEqual(abstained, {
    results: [],
    decision: { answerable: false, abstained: true, reason: 'no_safe_result' },
  });
});

test('ordinary queries preserve the storage ranking unchanged', () => {
  const input = [
    result({ id: 'a', subject: '롯데건설 업무' }),
    result({ id: 'b', subject: '롯데건설 계약' }),
  ];
  assert.equal(rerankSemanticSearchResults('롯데건설', input), input);
  assert.deepEqual(semanticSearchIntent('롯데건설'), {
    normalized: '롯데건설',
    completedPatchTicket: false,
    completedSupport: false,
    hciLicenseIncident: false,
    security: false,
    sharedVerification: false,
    quotationOrderProgress: false,
    invoiceHumanReview: false,
    completedHistoryFollowup: false,
  });
});
