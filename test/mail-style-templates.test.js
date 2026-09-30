import test from 'node:test';
import assert from 'node:assert/strict';

import { generateSafeDraft } from '../src/domain/mail-assistant-tools.js';
import { renderMailTemplate, selectMailTemplate } from '../src/domain/mail-style-templates.js';

const NEED = '{확인 필요}';

test('selects a template from the received mail type and defaults to T3', () => {
  assert.equal(selectMailTemplate({ subject: '세금계산서 발행 요청', body: '발행 부탁드립니다.' }), 'T5');
  assert.equal(selectMailTemplate({ subject: '발주 진행', body: '발주서 확인 부탁드립니다.' }), 'T4');
  assert.equal(selectMailTemplate({ subject: '견적 요청', body: '갱신 견적 요청드립니다.' }), 'T1');
  assert.equal(selectMailTemplate({ subject: '견적서 검토', body: '견적서를 전달드립니다.' }), 'T2');
  assert.equal(selectMailTemplate({ subject: '라이선스 전달', body: '자료 확인 부탁드립니다.' }), 'T6');
  assert.equal(selectMailTemplate({ subject: '기술 지원', body: '원격 지원이 필요합니다.' }), 'T7');
  assert.equal(selectMailTemplate({ subject: '안녕하세요', body: '잘 받았습니다.' }), 'T3');
});

test('fills only evidence-backed values and leaves the rest unmarked guesses', () => {
  const source = '홍길동 팀장입니다. 고객사: 한빛소프트. 제품: HCI-100.';
  const rendered = renderMailTemplate('T1', {
    message: { subject: '견적 요청', body: source, from: '홍길동 팀장 <hong@example.com>' },
    evidence: {
      고객사: '한빛소프트',
      제품: 'HCI-100',
      금액: '1500000',
      담당자: '김추정',
    },
  });
  assert.equal(rendered.templateId, 'T1');
  assert.match(rendered.body, /한빛소프트/);
  assert.match(rendered.body, /HCI-100/);
  assert.match(rendered.body, /홍길동 팀장님/);
  assert.doesNotMatch(rendered.body, /1500000|김추정/);
  assert.match(rendered.body, /\{확인 필요\}/);
  assert.equal(rendered.unfilled.includes('수량 또는 기간'), true);
  assert.equal(rendered.unfilled.includes('담당자'), false);
});

test('draft generator uses the selected template and still cannot send', () => {
  const draft = generateSafeDraft({
    message: {
      id: 'm-tax',
      subject: '세금계산서 요청',
      from: '회계 담당자 <tax@example.com>',
      body: '세금계산서 발행 요청드립니다. 대상: 9월 유지보수.',
    },
    classification: { workState: 'action_required' },
    mode: 'rapid_reply',
    evidence: { 건명: '9월 유지보수' },
  });
  assert.equal(draft.templateId, 'T5');
  assert.match(draft.body, /9월 유지보수/);
  assert.match(draft.body, /베를로 박재민입니다/);
  assert.equal(draft.sendAllowed, false);
  assert.equal(draft.requiresHumanApproval, true);
  assert.equal(draft.action, 'copy_only');
  assert.equal(draft.body.includes(NEED) || draft.unfilled.length > 0, true);
});

test('reply drafts use RE plus the original subject and drop stacked prefixes', () => {
  const draft = generateSafeDraft({
    message: {
      subject: 'Re: RE: 회신: [공유] 견적 검토',
      from: '홍길동 팀장 <hong@example.com>',
      body: '잘 받았습니다.',
    },
    mode: 'rapid_reply',
  });
  assert.equal(draft.subject, 'RE: [공유] 견적 검토');
  assert.equal(draft.subject.includes(NEED), false);
});

test('new-mail template subject fills known fields and keeps unknown slots', () => {
  const rendered = renderMailTemplate('T1', {
    message: {
      subject: '견적 요청',
      body: '고객사: 한빛소프트. 제품: HCI-100.',
      from: '홍길동 팀장 <hong@example.com>',
    },
    evidence: {
      고객사: '한빛소프트',
      제품: 'HCI-100',
      citations: { 고객사: 'message.body', 제품: 'message.body' },
    },
  });
  assert.equal(rendered.subject, `[베를로] 한빛소프트 HCI-100 ${NEED} 견적 요청 건`);
});

test('new mail without a template subject stays 확인 필요', () => {
  const draft = generateSafeDraft({
    message: { subject: '', from: '', body: '안녕하세요' },
    mode: 'new_mail',
  });
  assert.equal(draft.subject, NEED);
});

test('new mail uses a deterministic template subject when fields are known', () => {
  const draft = generateSafeDraft({
    message: {
      subject: '',
      from: '홍길동 팀장 <hong@example.com>',
      body: '고객사 한빛소프트 제품 HCI-100 신규 견적 요청드립니다.',
    },
    mode: 'new_mail',
    evidence: {
      고객사: '한빛소프트',
      제품: 'HCI-100',
      '신규/갱신': '신규',
      citations: {
        고객사: 'message.body',
        제품: 'message.body',
        '신규/갱신': 'message.body',
      },
    },
  });
  assert.equal(draft.templateId, 'T1');
  assert.equal(draft.subject, '[베를로] 한빛소프트 HCI-100 신규 견적 요청 건');
  assert.equal(draft.sendAllowed, false);
});

test('T6 keeps unknown recipient fields as 확인 필요', () => {
  const rendered = renderMailTemplate('T6', {
    message: { subject: '자료', body: '', from: '' },
    evidence: { 자료명: '발송 확인 파일', citations: { 자료명: 'attachment:test.txt' } },
  });
  assert.equal(rendered.templateId, 'T6');
  assert.match(rendered.body, /^담당자님, 안녕하세요/m);
  assert.doesNotMatch(rendered.body.split('\n')[0], /@|\{확인 필요\}/);
  assert.match(rendered.body, /발송 확인 파일/);
  assert.match(rendered.subject, /\[베를로\]/);
});
