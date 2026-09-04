import {
  NEXT_ACTORS,
  PRIORITIES,
  SUPPORTING_SIGNALS,
  WORK_STATES,
} from './precision-classifier.js';

export const INTELLIGENT_SEARCH_VERSION = 'intelligent-search-v1.2.2-fix11';
export const MAX_INTELLIGENT_QUERY_LENGTH = 500;
export const MAX_INTELLIGENT_SEARCH_RESULTS = 100;

const STATE_PHRASES = [
  { value: 'action_required', pattern: /(?:내가|우리가|우리\s*쪽이)\s*(?:해야|처리|답장|회신|보내)|해야\s*할\s*(?:일|메일)|액션\s*필요|action\s*required|to\s*do/i },
  { value: 'waiting', pattern: /(?:회신|답변|승인|자료|고객|상대방|외부|내부)\s*대기|대기\s*(?:중(?:인)?\s*)?(?:라이선스|라이센스|회신|답변|고객|외부)|기다리(?:는|고)|waiting|awaiting|pending/i },
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

const PRESERVED_DOMAIN_TOKEN_PATTERN = /견적|발주|계약|세금계산서|주문서|라이선스|라이센스|장애|보안|해킹|침해|랜섬웨어|quotation|quote|contract|purchase|order|invoice|incident|outage|security|breach|malware/i;
const INCIDENT_LEXICAL_EXPANSIONS = Object.freeze({
  장애: ['장애', '오류', '중단', '접속불가', 'outage', 'incident'],
  보안: ['보안', 'security', 'vpn', '침해', '해킹'],
  security: ['security', '보안', 'vpn', 'breach', 'malware'],
  incident: ['incident', '장애', '오류', 'outage'],
  outage: ['outage', '장애', '중단', '접속불가'],
});

const DUE_PHRASES = [
  { value: 'overdue', pattern: /기한\s*(?:지난|초과)|마감\s*(?:지난|초과)|연체|overdue|past\s*due/i },
  { value: 'today', pattern: /오늘(?:까지|\s*마감)?|금일(?:까지|\s*마감)?|due\s*today/i },
  { value: 'tomorrow', pattern: /내일(?:까지|\s*마감)?|due\s*tomorrow/i },
  { value: 'this_week', pattern: /이번\s*주|금주|this\s*week/i },
  { value: 'has_due', pattern: /기한\s*있는|마감\s*있는|due\s*date/i },
  { value: 'no_due', pattern: /기한\s*없는|마감\s*없는|no\s*deadline|without\s*due/i },
];

const WEAK_SEARCH_TOKENS = new Set(['업무', '관련', '필요', '메일', '문서', '확인', '검토', '자동', '생성', '하면', '하는', '해서', '되는', '되어', '될']);
const CONTROL_PARTICLE_SUFFIXES = ['에게', '에서', '으로', '만', '도', '을', '를', '이', '가', '은', '는', '과', '와', '에', '로'];
const CONTROL_AUXILIARY_SUFFIXES = ['하면', '하는', '해서', '되는', '되어', '될'];
const CONTROL_AUXILIARY_BASES = new Set(['확인', '생성', '처리']);
const DEADLINE_CUE_PATTERN = /(?:까지|by\b|제출|납기|마감|회신)/i;
const ABSOLUTE_DATE_PATTERN = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b|(20\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일|\b(\d{1,2})[-/.](\d{1,2})\b|(\d{1,2})월\s*(\d{1,2})일/;
const SECURITY_TERM_PATTERN = /보안|security/i;
const OUTAGE_PATTERN = /장애|중단|outage/i;
const REMOTE_SESSION_GROUP_PATTERN = /원격|remote|vpn|접속|session|access/i;
const SECURITY_OUTAGE_CONJUNCTION_PATTERN = /(?:보안|security)\s*(?:및|과|와|and)\s*(?:장애|중단|outage)|(?:장애|중단|outage)\s*(?:및|과|와|and)\s*(?:보안|security)|(?:보안|security)\s*[-/+/]\s*(?:장애|중단|outage)|(?:장애|중단|outage)\s*[-/+/]\s*(?:보안|security)/i;

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeControlToken(value = '') {
  let token = String(value).normalize('NFKC');
  for (const suffix of CONTROL_AUXILIARY_SUFFIXES) {
    if (!token.toLowerCase().endsWith(suffix) || token.length <= suffix.length) continue;
    const base = token.slice(0, -suffix.length);
    if (CONTROL_AUXILIARY_BASES.has(base.toLowerCase())) token = base;
    break;
  }
  while (token.length > 1) {
    const suffix = CONTROL_PARTICLE_SUFFIXES.find((item) => token.toLowerCase().endsWith(item));
    if (!suffix || token.length <= suffix.length) break;
    const base = token.slice(0, -suffix.length);
    if (!WEAK_SEARCH_TOKENS.has(base.toLowerCase()) && !PRESERVED_DOMAIN_TOKEN_PATTERN.test(base)) break;
    token = base;
  }
  return token;
}

function consumePattern(text, pattern) {
  return text.replace(pattern, ' ');
}

function semanticIntentFor(query = '') {
  const normalized = normalizeSpace(query).toLowerCase();
  const completed = /완료|종료|해결|completed|closed|resolved/.test(normalized);
  const patch = /패치|patch|kernel/.test(normalized);
  const ticket = /티켓|ticket|case/.test(normalized);
  const sangfor = /sangfor|상포/.test(normalized);
  const support = /지원|문의|support|ticket|case/.test(normalized);
  const waiting = /대기|기다리|waiting|awaiting|pending/.test(normalized);
  const license = /라이선스|라이센스|license|licence/.test(normalized);
  const reply = /회신|답변|응답|reply|response/.test(normalized);
  const review = /검토|review/.test(normalized);
  const taxInvoice = /세금계산서|tax\s*invoice/.test(normalized);
  const deactivation = /비활성화|해지|중지|deactivat|inactive|suspend/.test(normalized);
  const confluence = /confluence/.test(normalized);
  const service = /confluence|서비스|계정|구독|subscription|workspace|account|service/.test(normalized);
  const sharedAsset = /공유\s*(?:폴더|파일)|shared\s*(?:folder|file)/.test(normalized);
  const verification = /이메일\s*인증|인증|email\s*verification|verify/.test(normalized);
  const iag = /\biag\b/.test(normalized);
  if (completed && sangfor && support) return 'completed_sangfor_support';
  if (completed && patch && ticket) return 'completed_support_ticket';
  if (waiting && license && reply) return 'waiting_license_reply';
  if (review && taxInvoice) return 'tax_invoice_review';
  if (confluence && deactivation) return 'confluence_deactivation';
  if (service && deactivation) return 'service_deactivation';
  if (sharedAsset && verification) return 'shared_access_verification';
  if (sangfor && iag) return 'sangfor_iag';

  const hci = /(?:^|\s|[[(])hci(?:$|\s|[)\]])/i.test(normalized);
  const incident = /장애|오류|중단|접속\s*불가|동작\s*하지|issue|problem|incident|outage|failed|expired/.test(normalized);
  if (hci && license && incident) return 'hci_license_incident';
  return '';
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

function absoluteDueRangeFor(query, nowValue) {
  const datePattern = new RegExp(ABSOLUTE_DATE_PATTERN.source, 'g');
  const isClauseBoundary = (index) => {
    const character = query[index];
    if (character === ',' || character === ';' || character === '|' || character === '\n') return true;
    return character === '.' && !/\d/.test(query[index - 1] || '') && !/\d/.test(query[index + 1] || '');
  };
  const candidates = [];
  let match;
  while ((match = datePattern.exec(query))) {
    let clauseStart = match.index;
    let clauseEnd = datePattern.lastIndex;
    while (clauseStart > 0 && !isClauseBoundary(clauseStart - 1)) clauseStart -= 1;
    while (clauseEnd < query.length && !isClauseBoundary(clauseEnd)) clauseEnd += 1;
    const clause = query.slice(clauseStart, clauseEnd);
    const cuePattern = new RegExp(DEADLINE_CUE_PATTERN.source, 'gi');
    const cueOffsets = [...clause.matchAll(cuePattern)].map((cue) => clauseStart + cue.index);
    if (!cueOffsets.length) continue;
    const year = Number(match[1] || match[4] || new Date(nowValue).getUTCFullYear());
    const month = Number(match[2] || match[5] || match[7] || match[9]);
    const day = Number(match[3] || match[6] || match[8] || match[10]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (!month || !day || candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) continue;
    const dateOffset = match.index + (match[0].length / 2);
    candidates.push({
      candidate,
      distance: Math.min(...cueOffsets.map((cueOffset) => Math.abs(cueOffset - dateOffset))),
      index: match.index,
    });
  }
  candidates.sort((left, right) => left.distance - right.distance || right.index - left.index);
  if (candidates.length) {
    const from = new Date(candidates[0].candidate.getTime() - (9 * 60 * 60 * 1000));
    const before = new Date(from.getTime() + (24 * 60 * 60 * 1000));
    return { from: from.toISOString(), before: before.toISOString(), requiresDue: true };
  }
  return {};
}

function searchPlanFor({ query, lexicalTokens, filters, absoluteDueRange }) {
  const softTokens = unique(lexicalTokens).filter((token) => !WEAK_SEARCH_TOKENS.has(normalizeControlToken(token).toLowerCase()));
  const hardAnchors = [];
  if (absoluteDueRange.from) hardAnchors.push({ kind: 'due_date', range: absoluteDueRange });
  if (filters.nextActors.includes('external_party')) hardAnchors.push({ kind: 'external_actor' });
  if (filters.project) hardAnchors.push({ kind: 'project', value: filters.project });
  const hasSecurity = SECURITY_TERM_PATTERN.test(query);
  const hasOutage = OUTAGE_PATTERN.test(query);
  if ((hasSecurity || hasOutage) && REMOTE_SESSION_GROUP_PATTERN.test(query)) {
    hardAnchors.push({
      kind: 'security_remote_session',
      requiresAllIssueTerms: hasSecurity && hasOutage && SECURITY_OUTAGE_CONJUNCTION_PATTERN.test(query),
      groups: [
        ['보안', 'security', '침해', '해킹', 'breach', 'malware', '랜섬웨어'],
        ['원격', 'remote', 'vpn', '접속', 'session', 'access'],
      ],
    });
  }
  const softTokenCount = softTokens.length;
  const hasStructuredFilter = Boolean(
    filters.workStates?.length
    || filters.nextActors?.length
    || filters.priorities?.length
    || filters.signals?.length
    || filters.dueFilter
    || filters.dueRange?.from
    || filters.dueRange?.before
    || filters.project
    || filters.reviewOnly
    || filters.lexicalIncidentSearch
    || filters.semanticIntent
  );
  const minimumCoverage = softTokenCount < 2
    ? null
    : hardAnchors.length > 0
      ? Math.max(1, Math.ceil(softTokenCount * 0.5))
      : Math.max(2, Math.ceil(softTokenCount * 0.6));
  return {
    hardAnchors,
    softTokens,
    enumerationFacets: [],
    fallbackPolicy: {
      mode: 'coverage',
      minimumCoverage,
      allowed: minimumCoverage !== null,
      failClosed: softTokenCount === 0 && !hasStructuredFilter,
    },
  };
}

export function parseIntelligentQuery(value, { now = new Date() } = {}) {
  const query = normalizeSpace(value);
  if (!query) throw new Error('Intelligent search query is required.');
  if (query.length > MAX_INTELLIGENT_QUERY_LENGTH) {
    throw new Error(`Intelligent search query must be ${MAX_INTELLIGENT_QUERY_LENGTH} characters or fewer.`);
  }

  const semanticIntent = semanticIntentFor(query);
  let residual = query;
  const states = [];
  const actors = [];
  const priorities = [];
  const signals = [];
  const dueFilters = [];
  const recognized = [];

  const compoundCompletionSearch = /(?:계약|검수|발주|문서)완료/u.test(query);
  for (const item of STATE_PHRASES) {
    if (!item.pattern.test(query)) continue;
    if (item.value === 'completed' && compoundCompletionSearch) continue;
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
  const lexicalIncidentOnly = /^(?:장애|보안|security|incident|outage)$/i.test(query);
  for (const item of SIGNAL_PHRASES) {
    if (!item.pattern.test(query)) continue;
    if (item.value === 'incident_security' && lexicalIncidentOnly) {
      recognized.push({ type: 'lexicalSignal', value: item.value });
      continue;
    }
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

  let normalizedStates = unique(states).filter((item) => WORK_STATES.includes(item));
  let normalizedActors = unique(actors).filter((item) => NEXT_ACTORS.includes(item));
  const normalizedPriorities = unique(priorities).filter((item) => PRIORITIES.includes(item));
  let normalizedSignals = unique(signals).filter((item) => SUPPORTING_SIGNALS.includes(item));
  if (semanticIntent === 'completed_support_ticket') {
    normalizedStates = ['completed'];
    residual = consumePattern(residual, /패치|patch|kernel|티켓|ticket|case/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'hci_license_incident') {
    normalizedSignals = normalizedSignals.filter((item) => item !== 'incident_security');
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'completed_sangfor_support') {
    normalizedStates = ['completed'];
    residual = consumePattern(residual, /지원|문의|support|ticket|case/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'waiting_license_reply') {
    normalizedStates = ['waiting'];
    normalizedActors = ['external_party'];
    residual = consumePattern(residual, /회신|답변|응답|reply|response/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'tax_invoice_review') {
    normalizedStates = ['review_required'];
    normalizedSignals = unique([...normalizedSignals, 'quotation_contract']);
    residual = consumePattern(residual, /세금계산서|tax\s*invoice/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'service_deactivation' || semanticIntent === 'confluence_deactivation') {
    normalizedStates = ['action_required'];
    normalizedActors = ['me'];
    residual = consumePattern(residual, /비활성화|해지|중지|deactivat|inactive|suspend/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'shared_access_verification') {
    normalizedStates = ['action_required'];
    normalizedActors = ['me'];
    residual = consumePattern(residual, /이메일\s*인증|인증|email\s*verification|verify/ig);
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  if (semanticIntent === 'sangfor_iag') {
    recognized.push({ type: 'semanticIntent', value: semanticIntent });
  }
  const normalizedDue = unique(dueFilters);
  const dueFilter = normalizedDue[0] || '';
  const dueRange = dueRangeFor(dueFilter, now);
  const absoluteDueRange = absoluteDueRangeFor(query, now);
  const effectiveDueRange = absoluteDueRange.from ? absoluteDueRange : dueRange;
  const residualStopWords = new Set([
    '메일', '찾아', '보여', '알려', '목록', '관련', '것', '건', '중',
    '에서', '대한', '할', '해야', '처리할', 'the', 'mail', 'email', 'show', 'find',
  ]);
  const originalTokens = query.match(/[\p{L}\p{N}_-]+/gu) || [];
  const preservedDomainTokens = unique(originalTokens
    .filter((token) => token.length >= 2 && PRESERVED_DOMAIN_TOKEN_PATTERN.test(token))
    .map(normalizeControlToken));
  const residualTokens = normalizeSpace(residual)
    .split(/\s+/)
    .map(normalizeControlToken)
    .filter((token) => token
      && token.length >= 2
      && !residualStopWords.has(token.toLowerCase())
      && !WEAK_SEARCH_TOKENS.has(token.toLowerCase())
      && !preservedDomainTokens.some((domainToken) => domainToken !== token && domainToken.includes(token)));
  const incidentExpansion = lexicalIncidentOnly
    ? INCIDENT_LEXICAL_EXPANSIONS[query.toLowerCase()] || [query]
    : [];
  const lexicalTokens = unique([...residualTokens, ...preservedDomainTokens, ...incidentExpansion]);
  const residualText = lexicalTokens.join(' ');
  const residualOperator = lexicalIncidentOnly
    || (lexicalTokens.length > 1 && lexicalTokens.every((token) => PRESERVED_DOMAIN_TOKEN_PATTERN.test(token)))
    ? 'OR'
    : 'AND';

  let filters = {
    workStates: normalizedStates,
    nextActors: normalizedActors,
    priorities: normalizedPriorities,
    signals: normalizedSignals,
    dueFilter,
    dueRange: effectiveDueRange,
    project: project?.value || '',
    reviewOnly: normalizedStates.includes('review_required'),
    lexicalIncidentSearch: lexicalIncidentOnly,
    lexicalIncidentKind: lexicalIncidentOnly ? query.toLowerCase() : '',
    semanticIntent,
  };
  const searchPlan = searchPlanFor({ query, lexicalTokens, filters, absoluteDueRange });
  if (searchPlan.hardAnchors.some((anchor) => anchor.kind === 'security_remote_session')) {
    filters = {
      ...filters,
      signals: filters.signals.filter((signal) => signal !== 'incident_security'),
    };
  }
  return {
    version: INTELLIGENT_SEARCH_VERSION,
    originalQuery: query,
    filters,
    residualText,
    residualOperator,
    searchPlan,
    recognized,
    hasStructuredFilters: Boolean(
      normalizedStates.length
      || normalizedActors.length
      || normalizedPriorities.length
      || normalizedSignals.length
      || dueFilter
      || project?.value
      || semanticIntent,
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
