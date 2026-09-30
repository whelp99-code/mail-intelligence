import { splitMessageHistory } from './precision-classifier.js';

export const MAIL_TEMPLATE_IDS = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
export const UNFILLED = '{확인 필요}';

const TITLE_PATTERN = /(팀장|과장|차장|부장|이사|대표|매니저|실장|센터장|수석|프로|사원|대리|주임|선임)/;
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/;
const ORG_NAME = /시스템|구매팀|주식회사|보험|센터|메일|Inc\b|Team\b|부서/;

export const DRAFT_SLOT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['slots'],
  properties: {
    slots: {
      type: 'array',
      maxItems: 24,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'quote'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 40 },
          quote: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
  },
});

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
- 기간: {기간}
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
  기간: '기간',
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

function currentBody(message = {}) {
  return splitMessageHistory(message.body || message.bodyPreview || '').currentContent;
}

function factSource(message = {}, attachmentText = '') {
  return [message.subject || '', message.body || message.bodyPreview || '', attachmentText || ''].join('\n');
}

function intentText(message = {}) {
  return `${message.subject || ''}\n${currentBody(message)}`;
}

function stripReplyPrefixes(subject = '') {
  let rest = normalizeSpace(subject);
  let guard = 0;
  const prefix = /^(?:re|fw|fwd|회신|전달)\s*[:：]\s*/i;
  while (prefix.test(rest) && guard < 8) {
    rest = rest.replace(prefix, '').trim();
    guard += 1;
  }
  return rest;
}

function quoteIn(source, value) {
  const clean = normalizeSpace(value);
  if (!clean || clean === UNFILLED || clean.includes(UNFILLED) || clean.includes('@')) return '';
  if (clean.length > 160) return '';
  if (source.includes(clean)) return clean;
  const pattern = clean.split(' ').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const match = source.match(new RegExp(pattern));
  return match ? normalizeSpace(match[0]) : '';
}

function firstLabeled(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const quoted = quoteIn(source, match?.[1] || '');
    if (quoted) return quoted;
  }
  return '';
}

function looksLikeOrg(name = '') {
  return ORG_NAME.test(name) || /[A-Za-z]{2,}/.test(name) && /[가-힣]/.test(name) && !TITLE_PATTERN.test(name);
}

function personFromDisplay(from = '') {
  const raw = normalizeSpace(String(from || '').replace(/<[^>]+>/g, ' ').replace(/["']/g, ' '));
  if (!raw || raw.includes('@') || EMAIL.test(raw)) return { name: '', title: '' };
  const titleMatch = raw.match(TITLE_PATTERN);
  const title = titleMatch ? titleMatch[1] : '';
  let name = normalizeSpace(raw.replace(TITLE_PATTERN, ' ').replace(/[,，]/g, ' '));
  if (/^[A-Za-z]/.test(raw) && raw.includes(',')) {
    const [last, first] = raw.split(',').map((part) => normalizeSpace(part.replace(/<[^>]+>/g, '')));
    name = normalizeSpace(`${first || ''} ${last || ''}`);
  }
  if (!name || looksLikeOrg(name) || EMAIL.test(name)) return { name: '', title };
  return { name, title };
}

function bodyBeforeHistory(value = '') {
  const text = String(value || '');
  let cut = text.length;
  const markers = [
    /^-{2,}\s*(?:original message|원본 메시지|원본 메세지|forwarded message)/im,
    /^(?:from|보낸\s*사람)\s*:/im,
    /님이\s*작성\s*:/m,
  ];
  for (const pattern of markers) {
    const match = text.match(pattern);
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  return text.slice(0, cut);
}

function personFromBody(text = '') {
  const title = TITLE_PATTERN.source;
  const intro = text.match(new RegExp(`(?<![가-힣])([가-힣]{2,4})\\s*${title}(?=\\s*입니다)`));
  if (intro && intro[1] !== '박재민') return { name: intro[1], title: intro[2] };
  const titled = text.match(new RegExp(`(?<![가-힣])([가-힣]{2,4})\\s*${title}(?=\\s|$)`));
  if (titled && titled[1] !== '박재민') return { name: titled[1], title: titled[2] };
  const signed = text.match(/(?<![가-힣])([가-힣]{2,4})\s*드림/);
  if (signed && signed[1] !== '박재민') {
    const near = text.match(new RegExp(`${signed[1]}\\s*${title}`));
    return { name: signed[1], title: near?.[1] || '' };
  }
  return { name: '', title: '' };
}

function koreanPersonDisplay(name = '') {
  const compact = name.replace(/\s/g, '');
  if (!/^[가-힣]{2,4}$/.test(compact)) return false;
  if (compact.length === 4 && !/\s/.test(name)) return false;
  return true;
}

export function recipientGreeting(message = {}) {
  const body = bodyBeforeHistory(message.body || message.bodyPreview || '');
  const fromBody = personFromBody(body);
  const fromDisplay = personFromDisplay(message.from);
  const displayOk = koreanPersonDisplay(fromDisplay.name) && !looksLikeOrg(fromDisplay.name);
  const name = fromBody.name || (displayOk ? fromDisplay.name : '');
  const title = fromBody.title || (displayOk ? fromDisplay.title : '');
  if (!name || looksLikeOrg(name)) return '담당자님';
  if (title && name !== title) return `${name} ${title}님`;
  return `${name}님`;
}

function firstRequestSentence(text = '') {
  const lines = String(text || '').split(/\n+/).map((line) => normalizeSpace(line)).filter(Boolean);
  const skipped = /안녕하세요|안녕하십니까|감사합니다|수고하십시오|박재민/;
  const picked = lines.find((line) => /문의|요청|부탁|확인/.test(line) && !skipped.test(line) && !line.includes('@') && line.length >= 8)
    || lines.find((line) => !skipped.test(line) && !line.includes('@') && line.length >= 8);
  if (!picked) return '';
  return quoteIn(text, picked.slice(0, 90));
}

function subjectProduct(subject = '') {
  let rest = stripReplyPrefixes(subject).replace(/^\[[^\]]{1,40}\]\s*/, '');
  rest = rest.replace(/\s*(?:및\s*)?20\d{2}년\s*예산\s*견적.*$/i, '');
  rest = rest.replace(/\s*견적\s*요청.*$/i, '');
  rest = rest.replace(/\s*네고\s*$/, '');
  return quoteIn(subject, rest);
}

function taxSubjectObject(subject = '') {
  const rest = stripReplyPrefixes(subject).replace(/^\[[^\]]{1,40}\]\s*/, '');
  const match = rest.match(/^(.{4,80}?)\s*(?:세금계산서|계산서)/);
  return quoteIn(subject, match?.[1] || '');
}

export function extractRuleSlots(message = {}, attachmentText = '') {
  const source = factSource(message, attachmentText);
  const values = {};
  const take = (key, value) => {
    const quoted = quoteIn(source, value);
    if (quoted) values[key] = quoted;
  };
  take('고객사', firstLabeled(source, [/고객사\s*[:：]\s*([^\n.]{2,40})/]));
  take('제품', firstLabeled(source, [/제품\s*[:：]\s*([^\n.]{2,80})/, /제품\/모델\s*[:：]\s*([^\n.]{2,80})/]));
  take('건명', firstLabeled(source, [/프로젝트명\s*[:：]?\s*([^▶\n]{4,80})/, /프로젝트\s*[:：]\s*([^▶\n]{4,80})/]));
  take('공급가', firstLabeled(source, [/발행금액\s*[:：]?\s*([\d,]{4,})/, /검수승인금액\s*[:：]?\s*([\d,]{4,})/, /금액\s*[:：]\s*([\d,]{4,})/]));
  take('금액', values.공급가 || firstLabeled(source, [/공급가\s*[:：]\s*([\d,]{4,})/]));
  take('기간', firstLabeled(source, [/계약기간\s*[:：]?\s*(20\d{2}-\d{2}-\d{2}\s*[~～-]\s*20\d{2}-\d{2}-\d{2})/, /(\d{2}년\s*[~～]\s*\d{2}년)/]));
  take('날짜', firstLabeled(source, [/발행\s*예정일\s*[:：]\s*([^\n]{4,40})/, /발행일\s*[:：]\s*([^\n]{4,40})/]));
  take('수량 또는 기간', firstLabeled(source, [/수량\/기간\s*[:：]\s*([^\n]{1,40})/, /수량\s*[:：]\s*([^\n]{1,40})/]));
  take('만료일', firstLabeled(source, [/만료일\s*[:：]\s*([^\n]{4,40})/]));
  take('참고', firstLabeled(source, [/참고\s*[:：]\s*([^\n]{2,80})/]));
  take('품목', firstLabeled(source, [/품목\s*[:：]\s*([^\n]{2,80})/]));
  take('납기', firstLabeled(source, [/납기\s*[:：]\s*([^\n]{2,40})/]));
  take('자료명', firstLabeled(source, [/자료명\s*[:：]\s*([^\n]{2,80})/]));
  take('대상', firstLabeled(source, [/대상\s*[:：]\s*([^\n]{2,80})/]));
  if (!values.제품 && /견적/.test(message.subject || '')) take('제품', subjectProduct(message.subject || ''));
  if (!values.고객사) take('고객사', uniqueCompany(source));
  if (!values.건명) take('건명', taxSubjectObject(message.subject || ''));
  if (!values['신규/갱신']) {
    if (/갱신|리뉴얼|renewal/i.test(source)) take('신규/갱신', source.match(/갱신/) ? '갱신' : '');
    else if (/신규/.test(intentText(message))) take('신규/갱신', '신규');
  }
  if (!values['받은 요청 요약']) take('받은 요청 요약', firstRequestSentence(currentBody(message)));
  if (!values['증상/요청'] && values['받은 요청 요약']) values['증상/요청'] = values['받은 요청 요약'];
  return values;
}

function backed(value, sourceText, citation) {
  const clean = normalizeSpace(value);
  if (!clean || clean === UNFILLED || clean.includes(UNFILLED) || clean.includes('@')) return '';
  if (/^\d[\d,.\s]*$/.test(clean) && !/(원|VAT)/.test(clean)) return '';
  if (normalizeSpace(citation)) return clean;
  return quoteIn(sourceText, clean);
}

function subjectIntent(subject = '') {
  const rest = stripReplyPrefixes(subject);
  if (/견적\s*요청|quote\s*request|예산\s*견적|견적\s*네고/i.test(rest)) return 'T1';
  if (/세금계산서|tax\s*invoice|계산서\s*\/\s*거래명세서|계산서\s*발행/i.test(rest)) return 'T5';
  if (/발주/.test(rest) && !/견적/.test(rest)) return 'T4';
  if (/기술\s*(?:지원|문의|회의)|장애|원격\s*지원/i.test(rest)) return 'T7';
  if (/견적서/.test(rest)) return 'T2';
  if (/견적/.test(rest) && !/참석|미팅/.test(rest)) return 'T2';
  if (/라이선스|라이센스|자료\s*(?:전달|요청)|license/i.test(rest) && !/견적/.test(rest)) return 'T6';
  return '';
}

export function selectMailTemplate(message = {}, classification = {}) {
  const fromSubject = subjectIntent(message.subject || '');
  if (fromSubject) return fromSubject;
  const text = `${intentText(message)}\n${classification.workState || ''}`;
  if (/견적\s*요청|quote\s*request/i.test(text) && !/견적서를\s*전달/.test(text)) return 'T1';
  if (/세금계산서|tax\s*invoice|계산서\s*및\s*거래명세서|계산서\s*발행/i.test(text)) return 'T5';
  if (/발주/.test(text)) return 'T4';
  if (/기술\s*지원|장애|오류|원격\s*지원|기술\s*문의|기술\s*회의|ticket/i.test(text)) return 'T7';
  if (/라이선스|라이센스|자료\s*(?:전달|요청)|license/i.test(text)) return 'T6';
  if (/참석|미팅으로|회의\s*참/.test(text) && !/견적\s*요청|견적서를\s*전달/.test(text)) return 'T3';
  if (/견적서를\s*(?:전달|송부|첨부)/.test(text)) return 'T2';
  if (/견적서/.test(text) && /전달|송부|첨부/.test(text)) return 'T2';
  return 'T3';
}

function uniqueCompany(source = '') {
  const found = new Set();
  const pattern = /(?<![A-Za-z가-힣])([A-Za-z가-힣0-9]{2,16}(?:건설|전자|소프트|바이오|증권))/g;
  let match;
  while ((match = pattern.exec(source))) found.add(match[1]);
  return found.size === 1 ? [...found][0] : '';
}

export function validateDraftSlotPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('draft slot payload must be an object');
  }
  if (Object.keys(payload).some((key) => key !== 'slots')) {
    throw new Error('draft slot payload has unknown fields');
  }
  if (!Array.isArray(payload.slots) || payload.slots.length > 24) {
    throw new Error('draft slot payload slots must be an array');
  }
  return {
    slots: payload.slots.map((item, index) => {
      if (!item || typeof item !== 'object') throw new Error(`slots[${index}] must be an object`);
      if (Object.keys(item).some((key) => key !== 'key' && key !== 'quote')) {
        throw new Error(`slots[${index}] has unknown fields`);
      }
      const key = normalizeSpace(item.key);
      const quote = normalizeSpace(item.quote);
      if (!key || key.length > 40 || !quote || quote.length > 160) {
        throw new Error(`slots[${index}] key and quote are required`);
      }
      return { key, quote };
    }),
  };
}

export function applyModelSlots(ruleValues, payload, sourceText) {
  const validated = validateDraftSlotPayload(payload);
  const values = { ...ruleValues };
  const fillSources = Object.fromEntries(Object.keys(ruleValues).filter((key) => ruleValues[key]).map((key) => [key, 'rules']));
  for (const slot of validated.slots) {
    if (values[slot.key]) continue;
    const quoted = quoteIn(sourceText, slot.quote);
    if (!quoted || quoted !== slot.quote && normalizeSpace(quoted) !== normalizeSpace(slot.quote)) continue;
    values[slot.key] = quoted;
    fillSources[slot.key] = 'model';
  }
  return { values, fillSources };
}

export function draftSlotPrompt(message = {}, attachmentText = '') {
  const source = factSource(message, attachmentText).slice(0, 6000);
  return `Extract mail draft slots. Return ONLY JSON matching the draft slot schema. Each quote must be an exact contiguous substring of the source. Do not invent amounts, dates, or promises. Use an empty slots array when unsure.\nSource:\n${source}`;
}

export function renderMailTemplate(templateId, { message = {}, evidence = {} } = {}) {
  const id = MAIL_TEMPLATE_IDS.includes(templateId) ? templateId : 'T3';
  const attachmentText = evidence.attachmentText || '';
  const sourceText = factSource(message, attachmentText);
  const citations = evidence.citations && typeof evidence.citations === 'object' ? evidence.citations : {};
  const fillSources = {};
  const values = {};
  const remember = (key, value, source) => {
    if (!value || values[key]) return;
    values[key] = value;
    fillSources[key] = source;
  };
  for (const [key, value] of Object.entries(extractRuleSlots(message, attachmentText))) {
    remember(key, value, 'rules');
  }
  for (const key of new Set(Object.values(SLOT_KEYS))) {
    remember(key, backed(evidence[key], sourceText, citations[key]), citations[key] ? 'rules' : 'rules');
  }
  if (evidence.modelSlots) {
    const applied = applyModelSlots(values, evidence.modelSlots, sourceText);
    Object.assign(values, applied.values);
    Object.assign(fillSources, applied.fillSources);
  }
  const signature = [
    '박재민 이사 | BLRO',
    `jm.park@blro.co.kr | ${values.전화 || UNFILLED}`,
    `${values.주소 || UNFILLED} | www.blro.co.kr`,
  ].join('\n');
  const greeting = recipientGreeting(message);
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
  let subject = SUBJECTS[id].replace(/\{([^{}]+)\}/g, (_, slot) => fill(slot));
  let body = BODIES[id]
    .replace('{담당자} {직함}님께', `${greeting}께`)
    .replace('{담당자} {직함}님', greeting);
  body = body.replace(/\{([^{}]+)\}/g, (_, slot) => fill(slot));
  return {
    templateId: id,
    subject,
    body,
    unfilled,
    greeting,
    fillSources,
  };
}

export async function fillDraftSlotsWithProvider({
  message = {},
  attachmentText = '',
  requestedProvider,
  callProvider,
  getModelName = () => 'unknown',
} = {}) {
  const ruleValues = extractRuleSlots(message, attachmentText);
  if (typeof callProvider !== 'function') {
    return { values: ruleValues, fillSources: Object.fromEntries(Object.keys(ruleValues).map((key) => [key, 'rules'])), model: '' };
  }
  const raw = await callProvider(requestedProvider, draftSlotPrompt(message, attachmentText));
  const payload = validateDraftSlotPayload(JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)));
  const applied = applyModelSlots(ruleValues, payload, factSource(message, attachmentText));
  return { ...applied, model: getModelName(requestedProvider) };
}
