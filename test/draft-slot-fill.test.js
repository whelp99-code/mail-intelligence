import test from 'node:test';
import assert from 'node:assert/strict';

import { generateSafeDraft } from '../src/domain/mail-assistant-tools.js';
import {
  applyModelSlots,
  extractRuleSlots,
  fillDraftSlotsWithProvider,
  renderMailTemplate,
  selectMailTemplate,
  validateDraftSlotPayload,
} from '../src/domain/mail-style-templates.js';

const NEED = '{확인 필요}';

function draftOf(message) {
  const templateId = selectMailTemplate(message);
  const rendered = renderMailTemplate(templateId, { message });
  const safe = generateSafeDraft({ message, mode: 'rapid_reply' });
  return { templateId, rendered, safe };
}

test('tax-invoice request fills subject object, amount, and period from the source', () => {
  const message = {
    subject: '[중요] 한빛건설 VPN 임대(26년~27년) 세금계산서 발행 요청의 건',
    from: '한빛구매시스템 <srm@example.com>',
    body: '안녕하세요. 한빛 구매팀입니다. ▶ 프로젝트: P100, 한빛건설 VPN 임대(26년~27년) ▶ 검수승인금액: 1,110,000 청구월: 2026-09',
  };
  const { templateId, rendered, safe } = draftOf(message);
  assert.equal(templateId, 'T5');
  assert.equal(safe.templateId, 'T5');
  assert.match(rendered.body, /^담당자님, 안녕하세요/);
  assert.match(rendered.body, /한빛건설 VPN 임대\(26년~27년\)/);
  assert.match(rendered.body, /1,110,000원/);
  assert.match(rendered.body, /26년~27년/);
  assert.doesNotMatch(rendered.body, /@|srm@example.com/);
  assert.equal(rendered.fillSources.공급가, 'rules');
  assert.equal(rendered.fillSources.기간, 'rules');
  assert.ok(rendered.unfilled.includes('날짜'));
});

test('quote subject wins over a tax-invoice mention and a license word', () => {
  const message = {
    subject: '[견적 요청] vGPU 2Node 유지보수 라이선스 네고 및 2027년 예산 견적 요청',
    from: '박민후 <buyer@example.com>',
    body: '표제의 라이선스가 적용됐습니다.\n다만 10월 초에 검수 및 세금계산서 발행을 요청드립니다.\n박민후 드림',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T1');
  assert.match(rendered.body, /박민후님/);
  assert.match(rendered.body, /vGPU 2Node 유지보수 라이선스/);
  assert.doesNotMatch(rendered.body, /요청하신 세금계산서 건 확인했습니다|@/);
  assert.equal(rendered.fillSources.제품, 'rules');
});

test('statement mail is a tax reply, not a license delivery', () => {
  const message = {
    subject: '[계산서/거래명세서] 남산발전 / 방화벽 라이선스 연장 계산서',
    from: 'buyer@example.com',
    body: '남산 발전 담당 김하늘 수석 입니다\n금액 : 2,040,000 (VAT 별도)\n정산 진행 부탁 드립니다',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T5');
  assert.match(rendered.body, /김하늘 수석님/);
  assert.match(rendered.body, /2,040,000원/);
  assert.doesNotMatch(rendered.body, /@example.com|을 전달드립니다/);
});

test('insurance reply does not paste the quoted incoming body', () => {
  const message = {
    subject: 'RE: [베를로] 계약이행보증보험 가입 요청 건',
    from: '잠실하남 <agent@example.com>',
    body: '안녕하세요 서울보증보험입니다\n계약보증보험건 전자서명 하시면 됩니다\n\n-----------------------원본 메세지-----------------------\n보낸사람: "박 재민"<owner@example.com>\n받는사람: agent@example.com\n보낸날짜: 2026-09-29\n제목: 계약이행보증보험 가입 요청 건\n요청하신 서류를 전달 드립니다.',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T3');
  assert.match(rendered.body, /^담당자님, 안녕하세요/);
  assert.match(rendered.body, /계약이행보증보험 가입 관련하여 회신드립니다/);
  assert.doesNotMatch(rendered.body, /전자서명 하시면 됩니다|원본 메세지|owner@example.com|요청하신 서류를 전달/);
});

test('technical meeting uses T7 and the sender display name', () => {
  const message = {
    subject: 'Fw: DB 업그레이드 기술 회의 결과',
    from: '손길동 <son@example.com>',
    body: '커널버전 확인 부탁드립니다.',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T7');
  assert.match(rendered.body, /손길동님/);
  assert.doesNotMatch(rendered.body.split('\n')[0], /@/);
  assert.match(rendered.body, new RegExp(NEED));
});

test('quoted history does not force a technical-support template', () => {
  const message = {
    subject: 'Re: 샘플 건으로 요청드립니다',
    from: '이하늘 <lee@example.com>',
    body: '이하늘 프로입니다.\n내부 협의 시간에 참석이 가능하신지 문의드립니다.\n\n2026년 7월 6일 홍길동 <old@example.com>님이 작성:\n기술 지원 오류가 있어 원격 지원이 필요합니다.',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T3');
  assert.match(rendered.body, /이하늘 프로님/);
  assert.doesNotMatch(rendered.body, /문의하신|원격 지원이 필요합니다|@/);
});

test('signature name and labeled tax facts fill when the display name is an address', () => {
  const message = {
    subject: '세금계산서 발행 요청의 건',
    from: 'buyer@example.com',
    body: '안녕하세요 담당자님, 샘플 구매팀 박하늘 입니다.\n프로젝트명 샘플소재 HCI 유지보수\n계약기간 2026-09-01 ~ 2027-08-31\n발행금액 3,300,000 원(VAT별도)\n박하늘 사원',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T5');
  assert.match(rendered.body, /박하늘 사원님/);
  assert.match(rendered.body, /샘플소재 HCI 유지보수/);
  assert.match(rendered.body, /3,300,000원/);
  assert.match(rendered.body, /2026-09-01 ~ 2027-08-31/);
  assert.doesNotMatch(rendered.body, /buyer@example.com/);
  for (const key of ['건명', '공급가', '기간']) assert.equal(rendered.fillSources[key], 'rules');
});

test('model slots are kept only when the quote is in the source', async () => {
  const message = {
    subject: '세금계산서 발행 요청',
    from: 'buyer@example.com',
    body: '대상 장비 유지보수 범위만 적혀 있습니다. 금액은 본문에 없습니다.',
  };
  assert.throws(() => validateDraftSlotPayload({ slots: [{ key: '공급가', quote: '1' }], extra: true }), /unknown fields/);
  const source = `${message.subject}\n${message.body}`;
  const rejected = applyModelSlots({}, { slots: [{ key: '공급가', quote: '8,800,000' }] }, source);
  assert.equal(rejected.values.공급가, undefined);
  const accepted = applyModelSlots({}, { slots: [{ key: '건명', quote: '대상 장비 유지보수' }] }, source);
  assert.equal(accepted.values.건명, '대상 장비 유지보수');
  assert.equal(accepted.fillSources.건명, 'model');
  const filled = await fillDraftSlotsWithProvider({
    message,
    requestedProvider: 'openai-codex-oauth',
    callProvider: async () => JSON.stringify({ slots: [{ key: '건명', quote: '대상 장비 유지보수' }, { key: '공급가', quote: '8,800,000' }] }),
    getModelName: () => 'test-model',
  });
  assert.equal(filled.values.건명, '대상 장비 유지보수');
  assert.equal(filled.values.공급가, undefined);
  assert.equal(filled.fillSources.건명, 'model');
  assert.equal(filled.model, 'test-model');
  const rulesOnly = extractRuleSlots(message);
  assert.equal(rulesOnly.공급가, undefined);
  const sentence = applyModelSlots({}, { slots: [{ key: '주제', quote: '계약보증보험건 전자서명 하시면 됩니다' }] }, '계약보증보험건 전자서명 하시면 됩니다');
  assert.equal(sentence.values.주제, undefined);
  const fallback = await fillDraftSlotsWithProvider({
    message,
    requestedProvider: 'xai-grok-oauth',
    callProvider: async () => { throw new Error('provider down'); },
  });
  assert.equal(fallback.fillMode, 'rules-fallback');
  assert.equal(fallback.values.공급가, undefined);
});

test('vendor reply does not reuse the customer quote request sentence', () => {
  const message = {
    subject: '[견적 요청] vGPU 2Node 유지보수 라이선스 네고 및 2027년 예산 견적 요청',
    from: '박민후 <buyer@example.com>',
    body: 'GS건설에서 vGPU 2Node 유지보수 라이선스 갱신 견적을 요청드립니다.\n만료일: 2026-10-13',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T1');
  assert.match(rendered.body, /요청하신 vGPU 2Node 유지보수 라이선스 견적 관련하여/);
  assert.doesNotMatch(rendered.body, /견적을 요청드립니다|GS건설에서 vGPU/);
  assert.equal(rendered.fillSources.제품, 'rules');
});

test('T3 topic is a subject noun phrase, not the counterpart sentence', () => {
  const message = {
    subject: 'RE: [베를로] 계약이행보증보험 가입 요청 건',
    from: '잠실하남 <agent@example.com>',
    body: '계약보증보험건 전자서명 하시면 됩니다',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T3');
  assert.match(rendered.body, /계약이행보증보험 가입 관련하여 회신드립니다/);
  assert.doesNotMatch(rendered.body, /전자서명 하시면 됩니다|에 대해 회신드립니다/);
  assert.equal(rendered.fillSources.주제, 'rules');
});

test('T7 topic is a subject noun phrase, not the counterpart request', () => {
  const message = {
    subject: 'Fw: DB/OS 업그레이드 및 재설치 관련 기술 회의 결과 및 추가 문의사항 회신드립니다.',
    from: '손길동 <son@example.com>',
    body: '이사님 커널버전 확인 부탁드립니다.',
  };
  const { templateId, rendered } = draftOf(message);
  assert.equal(templateId, 'T7');
  assert.match(rendered.body, /문의하신 DB\/OS 업그레이드 및 재설치 관련하여/);
  assert.doesNotMatch(rendered.body, /커널버전 확인 부탁드립니다|에 대해 회신드립니다/);
  assert.equal(rendered.fillSources.주제, 'rules');
});
