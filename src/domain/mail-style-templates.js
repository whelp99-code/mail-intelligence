import { splitMessageHistory } from './precision-classifier.js';

export const MAIL_TEMPLATE_IDS = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
export const UNFILLED = '{확인 필요}';

const TITLE_PATTERN = /(팀장|과장|차장|부장|이사|대표|매니저|실장|센터장)/;

const SUBJECTS = Object.freeze({
  T1: '[베를로] {고객사} {제품} {신규/갱신} 견적 요청 건',
  T2: '[공유] {고객사} {범위} 견적서',
  T3: '',
  T4: '[베를로] {고객사} {제품} 발주 건',
  T5: '',
  T6: '[베를로] {자료명} 자료 전달',
  T7: '',
});

const BODIES = Object.freeze({
  T1: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

{고객사}에서 {제품} {신규/갱신} 견적을 요청드립니다.
- 고객사: {고객사}
- 제품: {제품/모델}
- 수량/기간: {수량 또는 기간}
- 현재 만료일: {만료일, 갱신일 때}
- 참고: {이전 PO/Key ID 등}

{특이 요청 한 문장}. 가능 여부도 함께 알려 주시면 감사하겠습니다.

감사합니다.
박재민 드림`,
  T2: `{담당자} {직함}님께
안녕하세요. (주)베를로 박재민입니다.

{고객사} {범위} 견적서를 전달드립니다.
- 범위: {범위}
- 공급가: {금액}원 (VAT별도)

상세는 첨부 PDF를 확인 부탁드립니다.
확인하시고 발주서 전달 부탁드립니다.

감사합니다.
{기본 서명}`,
  T3: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

{받은 요청 요약 한 문장}에 대해 회신드립니다.
- {답변 1}
- {답변 2}

추가로 필요한 사항 있으시면 말씀 부탁드립니다.
감사합니다.
박재민 드림`,
  T4: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

{고객사} {제품} 발주 드립니다. 발주서 첨부드립니다.
- 품목/수량: {품목, 수량}
- 금액: {금액}원 (VAT별도)
- 납기 요청: {납기}

확인 후 회신 부탁드립니다.
감사합니다.
{기본 서명}`,
  T5: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

요청하신 세금계산서 건 확인했습니다.
- 대상: {건명}
- 금액: {공급가}원 (VAT별도)
- 발행 예정일: {날짜}

발행 후 다시 안내드리겠습니다.
감사합니다.
박재민 드림`,
  T6: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

{대상} {자료명}을 전달드립니다. 첨부 확인 부탁드립니다.

내용 확인 부탁드리며, 관련하여 문의사항이 있으시면 언제든 말씀 부탁드립니다.
감사합니다.
{기본 서명}`,
  T7: `{담당자} {직함}님, 안녕하세요.
베를로 박재민입니다.

문의하신 {증상/요청} 관련하여 회신드립니다.
- 확인 내용: {확인한 사실}
- 조치/제안: {조치}
- 다음 단계: {일정·담당}

{원격 지원/방문이 필요하면 가능 일정 요청 한 문장}
감사합니다.
{기본 서명}`,
});

const SLOT_KEYS = Object.freeze({
  담당자: '담당자',
  직함: '직함',
  고객사: '고객사',
  제품: '제품',
  '제품/모델': '제품',
  '신규/갱신': '신규/갱신',
  '수량 또는 기간': '수량 또는 기간',
  '만료일, 갱신일 때': '만료일',
  '이전 PO/Key ID 등': '참고',
  '특이 요청 한 문장': '특이 요청',
  범위: '범위',
  금액: '금액',
  '받은 요청 요약 한 문장': '받은 요청 요약',
  '답변 1': '답변 1',
  '답변 2': '답변 2',
  '품목, 수량': '품목',
  납기: '납기',
  건명: '건명',
  공급가: '공급가',
  날짜: '날짜',
  대상: '대상',
  자료명: '자료명',
  '증상/요청': '증상/요청',
  '확인한 사실': '확인한 사실',
  조치: '조치',
  '일정·담당': '일정·담당',
  '원격 지원/방문이 필요하면 가능 일정 요청 한 문장': '일정 요청',
});

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

const REPLY_PREFIX = /^(?:re|회신)\s*[:：]\s*/i;

export function replySubject(subject = '') {
  let rest = normalizeSpace(subject);
  let guard = 0;
  while (REPLY_PREFIX.test(rest) && guard < 8) {
    rest = rest.replace(REPLY_PREFIX, '').trim();
    guard += 1;
  }
  return `RE: ${rest || '(제목 없음)'}`;
}

function currentText(message = {}) {
  const body = splitMessageHistory(message.body || message.bodyPreview || '').currentContent;
  return `${message.subject || ''}\n${body}\n${message.from || ''}`;
}

function displayName(from = '') {
  const raw = String(from || '').replace(/<[^>]+>/g, ' ').replace(/["']/g, ' ');
  return normalizeSpace(raw).replace(/\s*(팀장|과장|차장|부장|이사|대표|매니저|실장|센터장)\s*/g, ' ').trim();
}

function titleFrom(from = '') {
  const match = String(from || '').match(TITLE_PATTERN);
  return match ? match[1] : '';
}

function backed(value, sourceText, citation) {
  const clean = normalizeSpace(value);
  if (!clean || clean === UNFILLED || clean.includes(UNFILLED)) return '';
  if (/^\d[\d,.\s]*$/.test(clean) && !/(원|VAT)/.test(clean)) return '';
  if (normalizeSpace(citation)) return clean;
  if (sourceText && sourceText.includes(clean)) return clean;
  return '';
}

export function selectMailTemplate(message = {}, classification = {}) {
  const text = `${message.subject || ''}\n${message.body || message.bodyPreview || ''}\n${classification.workState || ''}`;
  if (/세금계산서|tax\s*invoice/i.test(text)) return 'T5';
  if (/발주/.test(text)) return 'T4';
  if (/기술\s*지원|장애|오류|원격\s*지원|기술\s*문의|ticket/i.test(text)) return 'T7';
  if (/라이선스|라이센스|자료\s*(?:전달|요청)|license/i.test(text)) return 'T6';
  if (/견적\s*요청|quote\s*request/i.test(text) && !/견적서/.test(text)) return 'T1';
  if (/견적서|견적/.test(text)) return 'T2';
  return 'T3';
}

export function renderMailTemplate(templateId, { message = {}, evidence = {} } = {}) {
  const id = MAIL_TEMPLATE_IDS.includes(templateId) ? templateId : 'T3';
  const sourceText = currentText(message);
  const citations = evidence.citations && typeof evidence.citations === 'object' ? evidence.citations : {};
  const values = {
    담당자: backed(displayName(message.from), sourceText, 'message.from') || backed(evidence.담당자, sourceText, citations.담당자),
    직함: backed(titleFrom(message.from), sourceText, 'message.from') || backed(evidence.직함, sourceText, citations.직함),
  };
  for (const key of new Set(Object.values(SLOT_KEYS))) {
    if (values[key]) continue;
    values[key] = backed(evidence[key], sourceText, citations[key]);
  }
  if (!values['받은 요청 요약']) {
    const sentence = normalizeSpace(splitMessageHistory(message.body || '').currentContent).slice(0, 180);
    values['받은 요청 요약'] = sentence || '';
  }
  const signature = [
    '박재민 이사 | BLRO',
    `jm.park@blro.co.kr | ${values.전화 || UNFILLED}`,
    `${values.주소 || UNFILLED} | www.blro.co.kr`,
  ].join('\n');
  const unfilled = [];
  const fill = (slot) => {
    if (slot === '기본 서명') return signature;
    const key = SLOT_KEYS[slot] || slot;
    const value = values[key];
    if (!value) {
      if (!unfilled.includes(key)) unfilled.push(key);
      return UNFILLED;
    }
    return value;
  };
  let subject = SUBJECTS[id];
  subject = subject.replace(/\{([^{}]+)\}/g, (_, slot) => fill(slot));
  const body = BODIES[id].replace(/\{([^{}]+)\}/g, (_, slot) => fill(slot));
  return {
    templateId: id,
    subject,
    body,
    unfilled,
  };
}
