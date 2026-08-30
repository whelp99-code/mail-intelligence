import {
  NEXT_ACTORS,
  PRIORITIES,
  SUPPORTING_SIGNALS,
  WORK_STATES,
} from './precision-classifier.js';

export const INTELLIGENT_SEARCH_VERSION = 'intelligent-search-v1.2.0';
export const MAX_INTELLIGENT_QUERY_LENGTH = 500;
export const MAX_INTELLIGENT_SEARCH_RESULTS = 100;

const STATE_PHRASES = [
  { value: 'action_required', pattern: /(?:내가|우리가|우리\s*쪽이)\s*(?:해야|처리|답장|회신|보내)|해야\s*할\s*(?:일|메일)|액션\s*필요|action\s*required|to\s*do/i },
  { value: 'waiting', pattern: /(?:회신|답변|승인|자료|고객|상대방|외부|내부)\s*대기|기다리(?:는|고)|waiting|awaiting|pending/i },
  { value: 'decision_required', pattern: /결정\s*필요|승인\s*필요|판단\s*필요|결재\s*필요|decision\s*required|approval\s*required/i },
  { value: 'completed', pattern: /완료(?:된|한)?|종료(?:된|한)?|처리\s*완료|completed|done|closed/i },
  { value: 'reference', pattern: /참고(?:용)?|조치\s*불필요|회신\s*불필요|reference|no\s*action/i },
  { value: 'review_required', pattern: /검토\s*필요|분류\s*불확실|애매(?:한|함)?|미분류|review\s*required|uncertain/i },
];

const ACTOR_PHRASES = [
  { value: 'me', pattern: /(?:내가|내\s*차례|나에게|우리\s*차례|mailbox\s*owner)/i },
  { value: 'internal_team', pattern: /내부\s*(?:팀|담당|회신|승인|검토)?|사내|우리\s*팀|엔지니어|기술팀|영업팀|회계팀|법무팀|internal\s*team/i },
  { value: 'external_party', pattern: /고객|상대방|외부|제조사|벤더|공급사|파트너|총판|customer|client|vendor|external\s*party/i },
  { value: 'shared', pattern: /공동|양측|함께\s*해야|shared|joint/i },
  { value: 'none', pattern: /다음\s*행동\s*없|조치\s*없|nobody|none/i },
  { value: 'unknown', pattern: /행동\s*주체\s*불명|담당\s*불명|unknown\s*actor/i },
];

const PRIORITY_PHRASES = [
  { values: ['critical'], pattern: /치명|최우선|심각|critical/i },
  { values: ['critical', 'high'], pattern: /긴급|중요|우선|high\s*priority|urgent/i },
  { values: ['normal'], pattern: /일반\s*우선순위|normal\s*priority/i },
  { values: ['low'], pattern: /낮은\s*우선순위|후순위|low\s*priority/i },
];

const SIGNAL_PHRASES = [
  { value: 'deadline', pattern: /기한|마감|납기|deadline|due/i },
  { value: 'amount', pattern: /금액|비용|가격|예산|amount|price|cost/i },
  { value: 'quotation_contract', pattern: /견적|계약|발주|주문|세금계산서|quotation|quote|contract|purchase\s*order|invoice/i },
  { value: 'attachment', pattern: /첨부|파일|attachment|attached/i },
  { value: 'attachment_missing', pattern: /첨부\s*(?:누락|없음|빠짐)|파일\s*(?:누락|없음)|missing\s*attachment/i },
  { value: 'schedule', pattern: /일정|회의|미팅|착수|납기|schedule|meeting|kickoff/i },
  { value: 'approval', pattern: /승인|결재|확정|approval|sign[- ]?off/i },
  { value: 'incident_security', pattern: /장애|보안|해킹|침해|악성|랜섬웨어|incident|outage|security|breach|malware/i },
];

const DUE_PHRASES = [
  { value: 'overdue', pattern: /기한\s*(?:지난|초과)|마감\s*(?:지난|초과)|연체|overdue|past\s*due/i },
  { value: 'today', pattern: /오늘(?:까지|\s*마감)?|금일(?:까지|\s*마감)?|due\s*today/i },
  { value: 'tomorrow', pattern: /내일(?:까지|\s*마감)?|due\s*tomorrow/i },
  { value: 'this_week', pattern: /이번\s*주|금주|this\s*week/i },
  { value: 'has_due', pattern: /기한\s*있는|마감\s*있는|due\s*date/i },
  { value: 'no_due', pattern: /기한\s*없는|마감\s*없는|no\s*deadline|without\s*due/i },
];

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function consumePattern(text, pattern) {
  return text.replace(pattern, ' ');
}

function parseProjectExpression(query) {
  const patterns = [
    /(?:프로젝트|project)\s*[:=]\s*"([^"]{1,120})"/i,
    /(?:프로젝트|project)\s*[:=]\s*'([^']{1,120})'/i,
    /(?:프로젝트|project)\s*[:=]\s*([^,;|]{1,120})/i,
  ];
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match) return { value: normalizeSpace(match[1]), pattern };
  }
  return null;
}

function startOfKstDay(value = new Date()) {
  const date = new Date(value);
  const shifted = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  ) - (9 * 60 * 60 * 1000));
}

export function dueRangeFor(filter, nowValue = new Date()) {
  const start = startOfKstDay(nowValue);
  const day = 24 * 60 * 60 * 1000;
  if (filter === 'overdue') return { before: start.toISOString(), requiresDue: true };
  if (filter === 'today') return { from: start.toISOString(), before: new Date(start.getTime() + day).toISOString(), requiresDue: true };
  if (filter === 'tomorrow') return { from: new Date(start.getTime() + day).toISOString(), before: new Date(start.getTime() + (2 * day)).toISOString(), requiresDue: true };
  if (filter === 'this_week') {
    const shifted = new Date(start.getTime() + (9 * 60 * 60 * 1000));
    const weekday = shifted.getUTCDay();
    const daysUntilMonday = weekday === 0 ? -6 : 1 - weekday;
    const monday = new Date(start.getTime() + (daysUntilMonday * day));
    return { from: monday.toISOString(), before: new Date(monday.getTime() + (7 * day)).toISOString(), requiresDue: true };
  }
  if (filter === 'has_due') return { requiresDue: true };
  if (filter === 'no_due') return { requiresDue: false };
  return {};
}

export function parseIntelligentQuery(value, { now = new Date() } = {}) {
  const query = normalizeSpace(value);
  if (!query) throw new Error('Intelligent search query is required.');
  if (query.length > MAX_INTELLIGENT_QUERY_LENGTH) {
    throw new Error(`Intelligent search query must be ${MAX_INTELLIGENT_QUERY_LENGTH} characters or fewer.`);
  }

  let residual = query;
  const states = [];
  const actors = [];
  const priorities = [];
  const signals = [];
  const dueFilters = [];
  const recognized = [];

  for (const item of STATE_PHRASES) {
    if (!item.pattern.test(query)) continue;
    states.push(item.value);
    residual = consumePattern(residual, item.pattern);
    recognized.push({ type: 'workState', value: item.value });
  }
  for (const item of ACTOR_PHRASES) {
    if (!item.pattern.test(query)) continue;
    actors.push(item.value);
    residual = consumePattern(residual, item.pattern);
    recognized.push({ type: 'nextActor', value: item.value });
  }
  for (const item of PRIORITY_PHRASES) {
    if (!item.pattern.test(query)) continue;
    priorities.push(...item.values);
    residual = consumePattern(residual, item.pattern);
    recognized.push({ type: 'priority', value: item.values.join('|') });
  }
  for (const item of SIGNAL_PHRASES) {
    if (!item.pattern.test(query)) continue;
    signals.push(item.value);
    residual = consumePattern(residual, item.pattern);
    recognized.push({ type: 'signal', value: item.value });
  }
  for (const item of DUE_PHRASES) {
    if (!item.pattern.test(query)) continue;
    dueFilters.push(item.value);
    residual = consumePattern(residual, item.pattern);
    recognized.push({ type: 'due', value: item.value });
  }

  const project = parseProjectExpression(query);
  if (project) {
    residual = consumePattern(residual, project.pattern);
    recognized.push({ type: 'project', value: project.value });
  }

  const normalizedStates = unique(states).filter((item) => WORK_STATES.includes(item));
  const normalizedActors = unique(actors).filter((item) => NEXT_ACTORS.includes(item));
  const normalizedPriorities = unique(priorities).filter((item) => PRIORITIES.includes(item));
  const normalizedSignals = unique(signals).filter((item) => SUPPORTING_SIGNALS.includes(item));
  const normalizedDue = unique(dueFilters);
  const dueFilter = normalizedDue[0] || '';
  const dueRange = dueRangeFor(dueFilter, now);
  const residualStopWords = new Set([
    '메일', '찾아', '보여', '알려', '목록', '관련', '것', '건', '중',
    '에서', '대한', '할', '해야', '처리할', 'the', 'mail', 'email', 'show', 'find',
  ]);
  const residualText = normalizeSpace(residual)
    .split(/\s+/)
    .filter((token) => token && !residualStopWords.has(token.toLowerCase()))
    .join(' ');

  return {
    version: INTELLIGENT_SEARCH_VERSION,
    originalQuery: query,
    filters: {
      workStates: normalizedStates,
      nextActors: normalizedActors,
      priorities: normalizedPriorities,
      signals: normalizedSignals,
      dueFilter,
      dueRange,
      project: project?.value || '',
      reviewOnly: normalizedStates.includes('review_required'),
    },
    residualText,
    recognized,
    hasStructuredFilters: Boolean(
      normalizedStates.length
      || normalizedActors.length
      || normalizedPriorities.length
      || normalizedSignals.length
      || dueFilter
      || project?.value,
    ),
  };
}

export function intelligentSmartViews(now = new Date()) {
  return [
    {
      id: 'my-actions',
      label: '내가 처리할 일',
      query: '내가 해야 할 일',
      filters: { workStates: ['action_required', 'decision_required'], nextActors: ['me'] },
    },
    {
      id: 'external-waiting',
      label: '고객·외부 회신 대기',
      query: '고객 회신 대기',
      filters: { workStates: ['waiting'], nextActors: ['external_party'] },
    },
    {
      id: 'due-today',
      label: '오늘 마감',
      query: '오늘 마감',
      filters: { dueFilter: 'today', dueRange: dueRangeFor('today', now) },
    },
    {
      id: 'overdue',
      label: '기한 초과',
      query: '기한 지난',
      filters: { dueFilter: 'overdue', dueRange: dueRangeFor('overdue', now) },
    },
    {
      id: 'decision-required',
      label: '결정·승인 필요',
      query: '결정 필요',
      filters: { workStates: ['decision_required'], nextActors: ['me'] },
    },
    {
      id: 'review-required',
      label: '검토 필요',
      query: '분류 불확실',
      filters: { workStates: ['review_required'], reviewOnly: true },
    },
    {
      id: 'commercial',
      label: '견적·계약·발주',
      query: '견적 계약 발주',
      filters: { signals: ['quotation_contract'] },
    },
    {
      id: 'security-incidents',
      label: '장애·보안',
      query: '장애 보안',
      filters: { signals: ['incident_security'] },
    },
    {
      id: 'unassigned-project',
      label: '프로젝트 미분류',
      query: '프로젝트 미분류',
      filters: { projectResolution: ['unassigned', 'candidate', 'review_required'] },
    },
  ];
}

export function explainIntelligentMatch(result, parsedQuery) {
  const reasons = [];
  const classification = result.classification || {};
  const filters = parsedQuery.filters || {};
  if (filters.workStates?.includes(classification.workState)) reasons.push(`업무 상태: ${classification.workState}`);
  if (filters.nextActors?.includes(classification.nextActor)) reasons.push(`다음 행동 주체: ${classification.nextActor}`);
  if (filters.priorities?.includes(classification.priority)) reasons.push(`우선순위: ${classification.priority}`);
  for (const signal of filters.signals || []) {
    if (classification.signals?.includes(signal)) reasons.push(`보조 신호: ${signal}`);
  }
  if (filters.dueFilter && classification.dueAt) reasons.push(`기한 조건: ${filters.dueFilter}`);
  if (filters.project && (classification.projectName || classification.projectCandidate?.label)) {
    reasons.push(`프로젝트: ${classification.projectName || classification.projectCandidate.label}`);
  }
  if (parsedQuery.residualText) reasons.push(`메일 근거 검색: ${parsedQuery.residualText}`);
  if (!reasons.length) reasons.push('구조화된 분류 및 메일 근거가 검색 조건과 일치');
  return reasons;
}
