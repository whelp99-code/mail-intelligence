import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('ordinary queries preserve the storage ranking unchanged', () => {
  const input = [
    result({ id: 'a', subject: '롯데건설 업무' }),
    result({ id: 'b', subject: '롯데건설 계약' }),
  ];
  assert.equal(rerankSemanticSearchResults('롯데건설', input), input);
  assert.deepEqual(semanticSearchIntent('롯데건설'), {
    normalized: '롯데건설',
    completedPatchTicket: false,
    hciLicenseIncident: false,
    security: false,
  });
});
