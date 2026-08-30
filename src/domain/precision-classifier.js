import { createHash } from 'node:crypto';

export const PRECISION_CLASSIFICATION_VERSION = 'precision-classification-v1.2.0';

export const WORK_STATES = Object.freeze([
  'action_required',
  'waiting',
  'decision_required',
  'completed',
  'reference',
  'review_required',
]);

export const NEXT_ACTORS = Object.freeze([
  'me',
  'internal_team',
  'external_party',
  'shared',
  'none',
  'unknown',
]);

export const PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);
export const PROJECT_RESOLUTIONS = Object.freeze(['confirmed', 'candidate', 'unassigned', 'review_required']);
export const DUE_PRECISIONS = Object.freeze(['exact', 'date', 'relative', 'ambiguous', 'none']);

export const SUPPORTING_SIGNALS = Object.freeze([
  'deadline',
  'amount',
  'quotation_contract',
  'attachment',
  'attachment_missing',
  'schedule',
  'approval',
  'incident_security',
]);

const NO_ACTION_PATTERN = /(?:별도|추가)?\s*(?:조치|회신|답변|확인).{0,10}(?:필요\s*(?:없|하지)|불필요)|회신\s*(?:불필요|필요\s*없)|참고\s*(?:용|바랍니다|해주세요)|단순\s*공지|뉴스레터|newsletter|unsubscribe|수신거부|\bfyi\b|for your information/i;
const CONCRETE_REQUEST_PATTERN = /(?:부탁(?:드립니다|합니다)?|요청(?:드립니다|합니다)?|해\s*주세요|하여\s*주세요|보내\s*주세요|바랍니다|필요(?:합니다|해요)|please\b|could you|would you|kindly)|(?:검토|확인|승인|작성|수정|제출|발송|보내|공유|전달|회신|답변|준비|일정\s*확정|견적\s*제공).{0,18}(?:부탁|요청|해주세요|보내주세요|바랍니다|필요)/i;
const ACTION_OBJECT_PATTERN = /견적(?:서)?|제안서|계약(?:서)?|발주(?:서)?|주문서|자료|문서|파일|첨부|정책(?:표)?|보고서|답변|회신|일정(?:표)?|미팅|회의|설치|구축|장비|라이선스|license|quotation|proposal|contract|document|file|reply|send|schedule/i;
const DECISION_PATTERN = /(?:최종\s*)?(?:결정|선택|승인|결재|확정).{0,18}(?:부탁|요청|해\s*주세요|바랍니다|필요)|(?:의견|판단).{0,18}(?:부탁|요청|해\s*주세요|바랍니다)|decision\s+(?:needed|required)|approval\s+(?:needed|required)/i;
const WAITING_PATTERN = /(?:회신|답변|승인|검토|확인|자료|견적|정책|결정).{0,18}(?:대기|기다리)|(?:대기|기다리).{0,18}(?:회신|답변|승인|검토|확인|자료|견적|정책|결정)|waiting\s+for|awaiting|pending\s+(?:approval|review|response|reply|document)/i;
const INTERNAL_ACTOR_PATTERN = /내부|사내|우리\s*팀|담당\s*팀|대표|팀장|엔지니어|기술팀|영업팀|회계팀|법무팀|보안팀|개발팀|internal|our\s+team|engineering\s+team|finance\s+team|legal\s+team/i;
const EXTERNAL_ACTOR_PATTERN = /고객|상대방|제조사|벤더|공급사|파트너|총판|리셀러|발주처|외부|customer|client|vendor|manufacturer|partner|supplier|external/i;
const EXTERNAL_COMMITMENT_PATTERN = /보내\s*드리겠습니다|전달\s*드리겠습니다|회신\s*드리겠습니다|공유\s*드리겠습니다|확인\s*후.{0,12}드리겠습니다|제공\s*하겠습니다|처리\s*하겠습니다|will\s+(?:send|reply|provide|confirm|review)/i;
const COMPLETED_PATTERN = /완료(?:했습니다|되었습니다|됨)|처리(?:했습니다|되었습니다)|발송(?:했습니다|되었습니다)|전달(?:했습니다|되었습니다)|해결(?:했습니다|되었습니다|됨)|종료(?:했습니다|되었습니다|됨)|closed|resolved|completed|done/i;
const CANCELLED_PATTERN = /취소(?:합니다|되었습니다|됐습니다|됨)|철회(?:합니다|되었습니다)|더\s*이상\s*진행하지|중단(?:합니다|되었습니다)|cancelled|canceled|withdrawn/i;
const URGENT_PATTERN = /긴급|즉시|오늘\s*중|금일\s*중|asap|urgent|critical|eod|장애|중단|침해|사고/i;
const AMOUNT_PATTERN = /(?:₩|\$|€|¥)\s?[\d,.]+|\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:원|달러|usd|krw|만원|억원)|\d+(?:\.\d+)?\s*(?:만원|억원)/i;
const QUOTATION_CONTRACT_PATTERN = /견적|발주|계약|주문서|세금계산서|quotation|quote|purchase\s*order|\bpo\b|contract|invoice/i;
const SCHEDULE_PATTERN = /일정|미팅|회의|착수|납기|반입|방문|설치일|구축일|schedule|meeting|kickoff|delivery\s+date/i;
const APPROVAL_PATTERN = /승인|결재|확정|approval|approve|sign[- ]?off/i;
const INCIDENT_SECURITY_PATTERN = /장애|서비스\s*중단|접속\s*불가|침해|해킹|악성|랜섬웨어|보안\s*사고|취약점|incident|outage|breach|malware|ransomware|vulnerability/i;
const ATTACHMENT_MENTION_PATTERN = /첨부|attachment|attached|파일을\s*보내|자료를\s*보내/i;
const ATTACHMENT_PROMISE_PATTERN = /첨부(?:드립니다|하였습니다|했습니다|합니다)|파일을\s*첨부|attached\s+(?:is|are)|please\s+find\s+attached/i;
const OWNER_PATTERN = /(?:담당|owner|pic)\s*[:：]\s*([^\n,;]+)/i;
const SHARED_PATTERN = /양측.{0,16}함께|함께.{0,16}(?:진행|확정|검토|대응|협의)|공동으로|각자.{0,16}(?:진행|확인|대응)|both\s+sides|together|joint\s+(?:action|response|review)/i;
const AMBIGUOUS_URGENCY_PATTERN = /가능한\s*빨리|조속히|빠른\s*시일|at\s+your\s+earliest|as\s+soon\s+as\s+possible/i;

const SIGNATURE_MARKERS = [
  /^--\s*$/,
  /^감사합니다[.!]?$/,
  /^고맙습니다[.!]?$/,
  /^best regards[,]?$/i,
  /^kind regards[,]?$/i,
  /^regards[,]?$/i,
  /^sent from my /i,
];

const QUOTE_MARKERS = [
  /^-{2,}\s*(?:original message|원본 메시지)\s*-{2,}$/i,
  /^_{5,}$/,
  /^(?:보낸 사람|발신|from)\s*:/i,
  /^(?:보낸 날짜|보낸 시각|sent)\s*:/i,
  /^on\s.+wrote:\s*$/i,
  /^>+\s*/,
];

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value = '') {
  return normalizeSpace(value).toLowerCase();
}

function boundedText(value, max = 1000) {
  return normalizeSpace(value).slice(0, max);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}

function fingerprintValue(value) {
  return createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

export function stripQuotedHistory(value = '') {
  const normalized = String(value || '').replace(/\r/g, '');
  const lines = normalized.split('\n');
  let end = lines.length;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (QUOTE_MARKERS.some((pattern) => pattern.test(trimmed))) {
      end = index;
      break;
    }
  }
  const current = lines.slice(0, end);
  for (let index = Math.max(1, current.length - 16); index < current.length; index += 1) {
    const trimmed = current[index].trim();
    if (SIGNATURE_MARKERS.some((pattern) => pattern.test(trimmed))) {
      return current.slice(0, index).join('\n').trim();
    }
  }
  return current.join('\n').trim();
}

function clausesWithOffsets(value = '') {
  const source = String(value || '');
  const clauses = [];
  const pattern = /[^.!?。！？\n]+[.!?。！？]?/gu;
  let match;
  while ((match = pattern.exec(source))) {
    const raw = match[0];
    const leading = raw.search(/\S/);
    if (leading < 0) continue;
    const text = raw.trim();
    if (text.length < 3) continue;
    const start = match.index + leading;
    clauses.push({ text, start, end: start + text.length });
  }
  return clauses;
}

function evidence(clause, field, rule) {
  if (!clause) return null;
  return {
    field,
    text: boundedText(clause.text, 1200),
    start: Number(clause.start || 0),
    end: Number(clause.end || 0),
    rule,
  };
}

function firstMatching(clauses, pattern) {
  return clauses.find((clause) => pattern.test(clause.text)) || null;
}

function matching(clauses, pattern) {
  return clauses.filter((clause) => pattern.test(clause.text));
}

function hasConcreteRequest(text) {
  const value = String(text || '');
  if (!CONCRETE_REQUEST_PATTERN.test(value)) return false;
  if (COMPLETED_PATTERN.test(value)
      && /(?:요청|부탁)(?:하신|한|했던|드렸던)/.test(value)
      && !/(?:해\s*주세요|보내\s*주세요|부탁드립니다|바랍니다|필요합니다)/.test(value)) return false;
  if (NO_ACTION_PATTERN.test(value)) {
    return value
      .split(/하지만|다만|그러나|but|however|[.;。]/i)
      .some((clause) => !NO_ACTION_PATTERN.test(clause) && CONCRETE_REQUEST_PATTERN.test(clause) && ACTION_OBJECT_PATTERN.test(clause));
  }
  if (/^\s*(?:확인|검토)\s*(?:부탁드립니다|바랍니다|해주세요)[.!]?\s*$/i.test(value)) return false;
  if (/(?:원인|장애|오류|문제|접속|서비스|현상).{0,24}(?:확인|조사|분석|조치).{0,12}(?:해\s*주세요|부탁|바랍니다)/i.test(value)) return true;
  if (ACTION_OBJECT_PATTERN.test(value)) return true;
  return /(?:오늘|내일|금일|이번\s*주|다음\s*주|\d{1,2}시|\d{4}[.-]\d{1,2}[.-]\d{1,2})/.test(value);
}

function kstParts(date) {
  const shifted = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function kstIso(year, month, day, hour = 18, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0)).toISOString();
}

function addKstDays(reference, days) {
  const parts = kstParts(reference);
  return new Date(Date.parse(kstIso(parts.year, parts.month, parts.day)) + (days * 24 * 60 * 60 * 1000));
}

function parseClock(text) {
  const korean = String(text).match(/(오전|오후)\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (korean) {
    let hour = Number(korean[2]);
    if (korean[1] === '오후' && hour < 12) hour += 12;
    if (korean[1] === '오전' && hour === 12) hour = 0;
    return { hour, minute: Number(korean[3] || 0), raw: korean[0] };
  }
  const digital = String(text).match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (digital) return { hour: Number(digital[1]), minute: Number(digital[2]), raw: digital[0] };
  const plain = String(text).match(/(?:^|\s)(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (plain) return { hour: Number(plain[1]), minute: Number(plain[2] || 0), raw: plain[0].trim() };
  return null;
}

function validDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() + 1 === month
    && candidate.getUTCDate() === day;
}

export function extractDue(text, referenceValue = new Date()) {
  const source = String(text || '');
  const reference = Number.isNaN(new Date(referenceValue).getTime()) ? new Date() : new Date(referenceValue);
  const base = kstParts(reference);
  const clock = parseClock(source) || { hour: 18, minute: 0, raw: '' };

  const isoDate = source.match(/\b(20\d{2})[-./](\d{1,2})[-./](\d{1,2})\b/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    if (validDateParts(year, month, day)) {
      return {
        dueText: boundedText(`${isoDate[0]}${clock.raw ? ` ${clock.raw}` : ''}`, 160),
        dueAt: kstIso(year, month, day, clock.hour, clock.minute),
        duePrecision: clock.raw ? 'exact' : 'date',
        confidence: clock.raw ? 0.96 : 0.92,
      };
    }
  }

  const koreanDate = source.match(/\b(?:(20\d{2})년\s*)?(\d{1,2})월\s*(\d{1,2})일\b/);
  if (koreanDate) {
    let year = Number(koreanDate[1] || base.year);
    const month = Number(koreanDate[2]);
    const day = Number(koreanDate[3]);
    if (!koreanDate[1] && month < base.month - 6) year += 1;
    if (validDateParts(year, month, day)) {
      return {
        dueText: boundedText(`${koreanDate[0]}${clock.raw ? ` ${clock.raw}` : ''}`, 160),
        dueAt: kstIso(year, month, day, clock.hour, clock.minute),
        duePrecision: clock.raw ? 'exact' : 'date',
        confidence: clock.raw ? 0.96 : 0.92,
      };
    }
  }

  const monthDay = source.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\s|$)/);
  if (monthDay) {
    let year = base.year;
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month < base.month - 6) year += 1;
    if (validDateParts(year, month, day)) {
      return {
        dueText: boundedText(`${monthDay[1]}/${monthDay[2]}${clock.raw ? ` ${clock.raw}` : ''}`, 160),
        dueAt: kstIso(year, month, day, clock.hour, clock.minute),
        duePrecision: clock.raw ? 'exact' : 'date',
        confidence: clock.raw ? 0.9 : 0.84,
      };
    }
  }

  const relativeDays = [
    { pattern: /오늘|금일/, days: 0 },
    { pattern: /내일/, days: 1 },
    { pattern: /모레/, days: 2 },
  ];
  for (const item of relativeDays) {
    const match = source.match(item.pattern);
    if (!match) continue;
    const relative = kstParts(addKstDays(reference, item.days));
    return {
      dueText: boundedText(`${match[0]}${clock.raw ? ` ${clock.raw}` : ''}`, 160),
      dueAt: kstIso(relative.year, relative.month, relative.day, clock.hour, clock.minute),
      duePrecision: 'relative',
      confidence: clock.raw ? 0.9 : 0.84,
    };
  }

  const weekdayMap = new Map([
    ['일요일', 0], ['월요일', 1], ['화요일', 2], ['수요일', 3],
    ['목요일', 4], ['금요일', 5], ['토요일', 6],
  ]);
  for (const [label, weekday] of weekdayMap) {
    if (!source.includes(label)) continue;
    let offset = (weekday - base.weekday + 7) % 7;
    if (/다음\s*주/.test(source)) offset += 7;
    const target = kstParts(addKstDays(reference, offset));
    return {
      dueText: boundedText(`${/다음\s*주/.test(source) ? '다음 주 ' : ''}${label}${clock.raw ? ` ${clock.raw}` : ''}`, 160),
      dueAt: kstIso(target.year, target.month, target.day, clock.hour, clock.minute),
      duePrecision: 'relative',
      confidence: 0.78,
    };
  }

  if (/이번\s*주|금주/.test(source)) {
    const offset = Math.max(0, 5 - base.weekday);
    const target = kstParts(addKstDays(reference, offset));
    return {
      dueText: /금주/.test(source) ? '금주' : '이번 주',
      dueAt: kstIso(target.year, target.month, target.day, 18, 0),
      duePrecision: 'relative',
      confidence: 0.68,
    };
  }

  if (/다음\s*주/.test(source)) {
    const daysUntilNextMonday = base.weekday === 0 ? 1 : 8 - base.weekday;
    const nextMonday = kstParts(addKstDays(reference, daysUntilNextMonday));
    const nextFriday = kstParts(addKstDays(new Date(kstIso(nextMonday.year, nextMonday.month, nextMonday.day)), 4));
    return {
      dueText: '다음 주',
      dueAt: kstIso(nextFriday.year, nextFriday.month, nextFriday.day, 18, 0),
      duePrecision: 'relative',
      confidence: 0.58,
    };
  }

  const ambiguous = source.match(AMBIGUOUS_URGENCY_PATTERN);
  if (ambiguous) {
    return {
      dueText: boundedText(ambiguous[0], 160),
      dueAt: null,
      duePrecision: 'ambiguous',
      confidence: 0.45,
    };
  }

  return {
    dueText: '',
    dueAt: null,
    duePrecision: 'none',
    confidence: 0,
  };
}

function projectTerms(project) {
  return unique([
    project.name,
    ...(Array.isArray(project.aliases) ? project.aliases : []),
    ...(Array.isArray(project.aliases_json) ? project.aliases_json : []),
  ]).map((value) => ({ raw: boundedText(value, 200), normalized: normalizeComparable(value) }))
    .filter((item) => item.normalized.length >= 2);
}

function containsTerm(text, term) {
  if (!term) return false;
  const particles = ['에서', '으로', '와', '과', '은', '는', '이', '가', '을', '를', '의', '및'];
  let start = 0;
  while (start <= text.length) {
    const index = text.indexOf(term, start);
    if (index < 0) return false;
    const before = index === 0 ? '' : text[index - 1];
    const beforeBoundary = !before || !/[\p{L}\p{N}]/u.test(before);
    const after = text.slice(index + term.length);
    const directBoundary = !after || !/[\p{L}\p{N}]/u.test(after[0]);
    const particleBoundary = particles.some((particle) => {
      if (!after.startsWith(particle)) return false;
      const following = after.slice(particle.length, particle.length + 1);
      return !following || !/[\p{L}\p{N}]/u.test(following);
    });
    if (beforeBoundary && (directBoundary || particleBoundary)) return true;
    start = index + Math.max(term.length, 1);
  }
  return false;
}

function extractProjectCandidate(subject, body) {
  const bracketMatches = [...String(subject || '').matchAll(/\[([^\]]{2,60})\]/g)]
    .map((match) => boundedText(match[1], 80))
    .filter((value) => !/^(?:re|fw|fwd|외부|external|공지|notice)$/i.test(value));
  if (bracketMatches.length === 1) {
    return { label: bracketMatches[0], source: 'subject-bracket', confidence: 0.72 };
  }
  const combined = `${subject || ''}\n${body || ''}`;
  const named = combined.match(/([\p{L}\p{N}][\p{L}\p{N} _./-]{1,42}(?:구축|도입|전환|고도화|개선|PoC|POC|프로젝트|사업))/u);
  if (named) return { label: boundedText(named[1], 80), source: 'project-phrase', confidence: 0.62 };
  return null;
}

export function resolveProject(message, projects = []) {
  const subject = normalizeComparable(message.subject || '');
  const body = normalizeComparable(stripQuotedHistory(message.body || message.bodyPreview || ''));
  const matches = [];
  for (const project of projects.filter((item) => String(item.status || 'active') === 'active')) {
    const terms = projectTerms(project);
    const subjectTerm = terms.find((term) => containsTerm(subject, term.normalized));
    const bodyTerm = terms.find((term) => containsTerm(body, term.normalized));
    if (!subjectTerm && !bodyTerm) continue;
    matches.push({
      projectId: Number(project.id),
      projectKey: project.projectKey || project.project_key || '',
      name: project.name,
      matchedTerm: (subjectTerm || bodyTerm).raw,
      source: subjectTerm ? 'subject' : 'body',
      confidence: subjectTerm ? 0.98 : 0.91,
    });
  }
  if (matches.length === 1) {
    return {
      primaryProjectId: matches[0].projectId,
      projectResolution: 'confirmed',
      projectCandidate: matches[0],
      confidence: matches[0].confidence,
      reviewReasons: [],
    };
  }
  if (matches.length > 1) {
    return {
      primaryProjectId: null,
      projectResolution: 'review_required',
      projectCandidate: { matches },
      confidence: Math.max(...matches.map((item) => item.confidence)),
      reviewReasons: ['multiple_project_matches'],
    };
  }
  const candidate = extractProjectCandidate(message.subject, body);
  if (candidate) {
    return {
      primaryProjectId: null,
      projectResolution: 'candidate',
      projectCandidate: candidate,
      confidence: candidate.confidence,
      reviewReasons: [],
    };
  }
  return {
    primaryProjectId: null,
    projectResolution: 'unassigned',
    projectCandidate: null,
    confidence: 0,
    reviewReasons: [],
  };
}

function supportingSignals(message, currentText) {
  const signals = [];
  if (extractDue(currentText, message.receivedAt || new Date()).duePrecision !== 'none') signals.push('deadline');
  if (AMOUNT_PATTERN.test(currentText)) signals.push('amount');
  if (QUOTATION_CONTRACT_PATTERN.test(currentText)) signals.push('quotation_contract');
  if (message.hasAttachments || ATTACHMENT_MENTION_PATTERN.test(currentText)) signals.push('attachment');
  if (!message.hasAttachments && ATTACHMENT_PROMISE_PATTERN.test(currentText)) signals.push('attachment_missing');
  if (SCHEDULE_PATTERN.test(currentText)) signals.push('schedule');
  if (APPROVAL_PATTERN.test(currentText)) signals.push('approval');
  if (INCIDENT_SECURITY_PATTERN.test(currentText)) signals.push('incident_security');
  return SUPPORTING_SIGNALS.filter((signal) => signals.includes(signal));
}

function stateAndEvidence(clauses, currentText) {
  const requestClauses = clauses.filter((clause) => hasConcreteRequest(clause.text));
  const decisionClauses = matching(clauses, DECISION_PATTERN);
  const waitingClauses = matching(clauses, WAITING_PATTERN);
  const completedClauses = matching(clauses, COMPLETED_PATTERN);
  const cancelledClauses = matching(clauses, CANCELLED_PATTERN);
  const noActionClauses = matching(clauses, NO_ACTION_PATTERN);
  const concreteDecision = decisionClauses.find((clause) => hasConcreteRequest(clause.text)) || decisionClauses[0];
  const concreteRequest = requestClauses[0];
  const waiting = waitingClauses[0];
  const completed = cancelledClauses[0] || completedClauses[0];
  const noAction = noActionClauses[0];
  const reviewReasons = [];

  if (!normalizeSpace(currentText)) {
    return {
      workState: 'review_required',
      stateConfidence: 0.2,
      stateEvidence: null,
      stateRule: 'empty-current-content',
      reviewReasons: ['empty_current_content'],
    };
  }

  if (concreteDecision && !WAITING_PATTERN.test(concreteDecision.text)) {
    return {
      workState: 'decision_required',
      stateConfidence: 0.94,
      stateEvidence: concreteDecision,
      stateRule: 'explicit-decision-request',
      reviewReasons,
    };
  }

  if (concreteRequest) {
    const contradictoryNoAction = noActionClauses.some((clause) => clause !== concreteRequest)
      && !/(?:하지만|다만|그러나|but|however)/i.test(currentText);
    if (contradictoryNoAction && !/(?:오늘|내일|금일|\d{4}[.-]\d{1,2}[.-]\d{1,2})/.test(concreteRequest.text)) {
      return {
        workState: 'review_required',
        stateConfidence: 0.48,
        stateEvidence: concreteRequest,
        stateRule: 'request-no-action-conflict',
        reviewReasons: ['request_no_action_conflict'],
      };
    }
    return {
      workState: 'action_required',
      stateConfidence: 0.94,
      stateEvidence: concreteRequest,
      stateRule: 'explicit-concrete-request',
      reviewReasons,
    };
  }

  if (waiting) {
    return {
      workState: 'waiting',
      stateConfidence: 0.9,
      stateEvidence: waiting,
      stateRule: 'explicit-waiting',
      reviewReasons,
    };
  }

  if (completed) {
    return {
      workState: 'completed',
      stateConfidence: 0.91,
      stateEvidence: completed,
      stateRule: cancelledClauses.length ? 'explicit-cancellation' : 'explicit-completion',
      reviewReasons,
    };
  }

  if (noAction || NO_ACTION_PATTERN.test(currentText)) {
    return {
      workState: 'reference',
      stateConfidence: 0.94,
      stateEvidence: noAction,
      stateRule: 'explicit-no-action',
      reviewReasons,
    };
  }

  if (EXTERNAL_COMMITMENT_PATTERN.test(currentText)) {
    const commitment = firstMatching(clauses, EXTERNAL_COMMITMENT_PATTERN);
    return {
      workState: 'waiting',
      stateConfidence: 0.84,
      stateEvidence: commitment,
      stateRule: 'external-commitment',
      reviewReasons,
    };
  }

  return {
    workState: 'review_required',
    stateConfidence: 0.4,
    stateEvidence: clauses[0] || null,
    stateRule: 'insufficient-action-evidence',
    reviewReasons: ['insufficient_action_evidence'],
  };
}

function actorAndEvidence(message, currentText, clauses, workState, stateEvidence, mailboxAddress = '') {
  if (workState === 'reference' || workState === 'completed') {
    return { nextActor: 'none', actorConfidence: 0.98, actorEvidence: stateEvidence, actorRule: 'no-next-action' };
  }
  const shared = stateEvidence && SHARED_PATTERN.test(stateEvidence.text) ? stateEvidence : null;
  if (shared) {
    return { nextActor: 'shared', actorConfidence: 0.82, actorEvidence: shared, actorRule: 'shared-action-language' };
  }
  if (workState === 'decision_required') {
    return { nextActor: 'me', actorConfidence: 0.93, actorEvidence: stateEvidence, actorRule: 'decision-owner' };
  }

  const sender = normalizeComparable(message.from || message.senderEmail || '');
  const own = normalizeComparable(mailboxAddress);
  const outgoing = Boolean(message.isOutgoing) || Boolean(own && sender === own);
  const owner = firstMatching(clauses, OWNER_PATTERN);
  if (owner) {
    const ownerName = owner.text.match(OWNER_PATTERN)?.[1] || '';
    if (INTERNAL_ACTOR_PATTERN.test(ownerName) || normalizeComparable(ownerName) !== normalizeComparable(message.fromName || '')) {
      return { nextActor: 'internal_team', actorConfidence: 0.82, actorEvidence: owner, actorRule: 'explicit-owner' };
    }
  }

  const internal = firstMatching(clauses, INTERNAL_ACTOR_PATTERN);
  const external = firstMatching(clauses, EXTERNAL_ACTOR_PATTERN);

  if (workState === 'waiting') {
    if (external) {
      return { nextActor: 'external_party', actorConfidence: 0.92, actorEvidence: external, actorRule: 'external-waiting' };
    }
    if (internal && !external) {
      return { nextActor: 'internal_team', actorConfidence: 0.9, actorEvidence: internal, actorRule: 'internal-waiting' };
    }
    const commitment = firstMatching(clauses, EXTERNAL_COMMITMENT_PATTERN);
    if (commitment && !outgoing) {
      return { nextActor: 'external_party', actorConfidence: 0.88, actorEvidence: commitment, actorRule: 'incoming-external-commitment' };
    }
    return { nextActor: 'unknown', actorConfidence: 0.45, actorEvidence: stateEvidence, actorRule: 'unresolved-waiting-actor' };
  }

  if (workState === 'action_required') {
    if (outgoing) {
      return { nextActor: 'external_party', actorConfidence: 0.86, actorEvidence: stateEvidence, actorRule: 'outgoing-request' };
    }
    if (internal && !external) {
      return { nextActor: 'internal_team', actorConfidence: 0.82, actorEvidence: internal, actorRule: 'explicit-internal-owner' };
    }
    return { nextActor: 'me', actorConfidence: 0.85, actorEvidence: stateEvidence, actorRule: 'incoming-request-default-owner' };
  }

  return { nextActor: 'unknown', actorConfidence: 0.35, actorEvidence: stateEvidence, actorRule: 'review-required-actor' };
}

function priorityAndEvidence(message, currentText, clauses, workState, due, signals, nowValue = new Date()) {
  const urgentClause = firstMatching(clauses, URGENT_PATTERN);
  const incidentClause = firstMatching(clauses, INCIDENT_SECURITY_PATTERN);
  const now = new Date(nowValue);
  const dueAt = due.dueAt ? new Date(due.dueAt) : null;
  const hours = dueAt ? (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000) : null;

  if (signals.includes('incident_security') && urgentClause) {
    return { priority: 'critical', priorityConfidence: 0.94, priorityEvidence: incidentClause || urgentClause, priorityRule: 'urgent-incident' };
  }
  if (workState === 'action_required' || workState === 'decision_required') {
    if (urgentClause || (hours != null && hours <= 48) || /오늘|내일|금일/.test(due.dueText || '')) {
      return { priority: 'high', priorityConfidence: 0.9, priorityEvidence: urgentClause || firstMatching(clauses, /오늘|내일|금일/), priorityRule: urgentClause ? 'explicit-urgency' : 'due-within-24h' };
    }
    return { priority: 'normal', priorityConfidence: 0.82, priorityEvidence: clauses[0] || null, priorityRule: 'action-default' };
  }
  if (workState === 'waiting') {
    if (hours != null && hours <= 24) {
      return { priority: 'high', priorityConfidence: 0.8, priorityEvidence: firstMatching(clauses, /오늘|내일|금일/) || clauses[0], priorityRule: 'waiting-deadline' };
    }
    return { priority: 'normal', priorityConfidence: 0.72, priorityEvidence: clauses[0] || null, priorityRule: 'waiting-default' };
  }
  if (workState === 'review_required') {
    return { priority: urgentClause ? 'high' : 'normal', priorityConfidence: urgentClause ? 0.68 : 0.45, priorityEvidence: urgentClause || clauses[0] || null, priorityRule: urgentClause ? 'review-with-urgency' : 'review-default' };
  }
  return { priority: 'low', priorityConfidence: 0.95, priorityEvidence: clauses[0] || null, priorityRule: 'non-action-low' };
}

function dueEvidenceClause(clauses, due) {
  if (!due.dueText) return null;
  return clauses.find((clause) => normalizeComparable(clause.text).includes(normalizeComparable(due.dueText)))
    || clauses.find((clause) => /오늘|내일|모레|금주|이번\s*주|다음\s*주|\d{4}[.-]\d{1,2}[.-]\d{1,2}|\d{1,2}월\s*\d{1,2}일/.test(clause.text))
    || null;
}

export function classificationFingerprint(classification) {
  return fingerprintValue({
    workState: classification.workState,
    nextActor: classification.nextActor,
    priority: classification.priority,
    dueText: classification.dueText || '',
    dueAt: classification.dueAt || null,
    duePrecision: classification.duePrecision || 'none',
    primaryProjectId: classification.primaryProjectId || null,
    projectResolution: classification.projectResolution,
    projectCandidate: classification.projectCandidate || null,
    signals: [...(classification.signals || [])].sort(),
    evidence: classification.evidence || {},
    confidence: classification.confidence || {},
    reviewReasons: [...(classification.reviewReasons || [])].sort(),
    reviewStatus: classification.reviewStatus,
  });
}

function legacyStatusFor(workState, priority) {
  if (workState === 'completed') return 'done';
  if (workState === 'reference') return 'reference';
  if (workState === 'waiting') return 'waiting';
  if (workState === 'action_required' || workState === 'decision_required') {
    return ['critical', 'high'].includes(priority) ? 'urgent' : 'active';
  }
  return 'active';
}

export function classifyMessage(message = {}, {
  projects = [],
  mailboxAddress = '',
  now = new Date(),
  source = 'rules',
  provider = 'rules',
  model = '',
  promptVersion = PRECISION_CLASSIFICATION_VERSION,
} = {}) {
  const body = stripQuotedHistory(message.body || message.bodyPreview || '');
  const currentText = [message.subject || '', body].filter(Boolean).join('\n');
  const clauses = clausesWithOffsets(currentText);
  const state = stateAndEvidence(clauses, currentText);
  const actor = actorAndEvidence(message, currentText, clauses, state.workState, state.stateEvidence, mailboxAddress);
  const due = extractDue(
    [state.stateEvidence?.text || '', ...clauses.map((clause) => clause.text)].join('\n'),
    message.receivedAt || now,
  );
  const signals = supportingSignals(message, currentText);
  const project = resolveProject(message, projects);
  const priority = priorityAndEvidence(message, currentText, clauses, state.workState, due, signals, now);
  const reviewReasons = unique([
    ...state.reviewReasons,
    ...project.reviewReasons,
    actor.nextActor === 'unknown' ? 'unknown_next_actor' : '',
    due.duePrecision === 'ambiguous' ? 'ambiguous_due' : '',
  ]);
  let workState = state.workState;
  if (project.projectResolution === 'review_required' && workState !== 'review_required') {
    reviewReasons.push('project_conflict_requires_review');
  }
  if (workState !== 'review_required' && actor.nextActor === 'unknown' && !['completed', 'reference'].includes(workState)) {
    workState = 'review_required';
  }
  const reviewStatus = workState === 'review_required' || project.projectResolution === 'review_required'
    ? 'review_required'
    : 'auto';
  const dueClause = dueEvidenceClause(clauses, due);
  const evidenceByField = {
    workState: evidence(state.stateEvidence, 'workState', state.stateRule),
    nextActor: evidence(actor.actorEvidence, 'nextActor', actor.actorRule),
    priority: evidence(priority.priorityEvidence, 'priority', priority.priorityRule),
    due: evidence(dueClause, 'due', due.duePrecision),
    project: project.projectCandidate?.matchedTerm
      ? {
        field: 'project',
        text: project.projectCandidate.matchedTerm,
        start: 0,
        end: project.projectCandidate.matchedTerm.length,
        rule: `registered-project-${project.projectCandidate.source}`,
      }
      : null,
  };
  const confidence = {
    workState: Number(state.stateConfidence.toFixed(3)),
    nextActor: Number(actor.actorConfidence.toFixed(3)),
    priority: Number(priority.priorityConfidence.toFixed(3)),
    due: Number(due.confidence.toFixed(3)),
    project: Number(project.confidence.toFixed(3)),
  };
  const classification = {
    messageId: String(message.id || ''),
    workState,
    nextActor: ['completed', 'reference'].includes(workState) ? 'none' : actor.nextActor,
    priority: priority.priority,
    dueText: due.dueText,
    dueAt: due.dueAt,
    duePrecision: due.duePrecision,
    primaryProjectId: project.primaryProjectId,
    projectResolution: project.projectResolution,
    projectCandidate: project.projectCandidate,
    signals,
    evidence: evidenceByField,
    confidence,
    reviewReasons: unique(reviewReasons),
    reviewStatus,
    source,
    provider,
    model,
    promptVersion,
    analyzedAt: new Date(now).toISOString(),
  };
  classification.legacyStatus = legacyStatusFor(classification.workState, classification.priority);
  classification.fingerprint = classificationFingerprint(classification);
  return classification;
}

function validatedOverride(value, allowed, field) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Invalid precision correction ${field}.`);
  return normalized;
}

export function normalizePrecisionCorrection(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Precision correction must be an object.');
  const overrides = {};
  const workState = validatedOverride(input.workState, WORK_STATES, 'workState');
  const nextActor = validatedOverride(input.nextActor, NEXT_ACTORS, 'nextActor');
  const priority = validatedOverride(input.priority, PRIORITIES, 'priority');
  const projectResolution = validatedOverride(input.projectResolution, PROJECT_RESOLUTIONS, 'projectResolution');
  if (workState) overrides.workState = workState;
  if (nextActor) overrides.nextActor = nextActor;
  if (priority) overrides.priority = priority;
  if (projectResolution) overrides.projectResolution = projectResolution;
  if (input.primaryProjectId != null && input.primaryProjectId !== '') {
    const projectId = Number(input.primaryProjectId);
    if (!Number.isInteger(projectId) || projectId < 1) throw new Error('Invalid precision correction primaryProjectId.');
    overrides.primaryProjectId = projectId;
  }
  if (input.clearProject === true) {
    overrides.primaryProjectId = null;
    overrides.projectResolution = 'unassigned';
    overrides.projectCandidate = null;
  }
  if (typeof input.dueText === 'string') overrides.dueText = boundedText(input.dueText, 160);
  if (input.dueAt === null || input.dueAt === '') {
    overrides.dueAt = null;
  } else if (typeof input.dueAt === 'string') {
    const date = new Date(input.dueAt);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid precision correction dueAt.');
    overrides.dueAt = date.toISOString();
  }
  const duePrecision = validatedOverride(input.duePrecision, DUE_PRECISIONS, 'duePrecision');
  if (duePrecision) overrides.duePrecision = duePrecision;
  return {
    overrides,
    reasonCode: boundedText(input.reasonCode, 120),
    note: boundedText(input.note, 1000),
    savedAt: input.savedAt ? new Date(input.savedAt).toISOString() : new Date().toISOString(),
  };
}

export function applyPrecisionCorrection(classification, correction) {
  if (!correction?.overrides || !Object.keys(correction.overrides).length) return classification;
  const next = {
    ...classification,
    ...correction.overrides,
    evidence: { ...classification.evidence },
    confidence: { ...classification.confidence },
    source: 'user-corrected',
    reviewStatus: 'corrected',
    correctedAt: correction.savedAt || new Date().toISOString(),
  };
  for (const field of Object.keys(correction.overrides)) {
    if (['workState', 'nextActor', 'priority', 'dueText', 'dueAt', 'duePrecision', 'primaryProjectId', 'projectResolution'].includes(field)) {
      const confidenceField = field.startsWith('due') ? 'due' : field === 'primaryProjectId' || field === 'projectResolution' ? 'project' : field;
      next.confidence[confidenceField] = 1;
      next.evidence[confidenceField] = {
        field: confidenceField,
        text: correction.note || correction.reasonCode || '사용자 보정',
        start: 0,
        end: 0,
        rule: 'user-correction',
      };
    }
  }
  if (['completed', 'reference'].includes(next.workState)) next.nextActor = 'none';
  if (next.workState === 'review_required' && next.reviewStatus !== 'corrected') next.reviewStatus = 'review_required';
  next.reviewReasons = unique([
    ...(classification.reviewReasons || []),
    correction.reasonCode ? `user:${correction.reasonCode}` : 'user-corrected',
  ]);
  next.legacyStatus = legacyStatusFor(next.workState, next.priority);
  next.fingerprint = classificationFingerprint(next);
  return next;
}

export function classifyMessages(messages = [], options = {}) {
  return messages.map((message) => classifyMessage(message, options));
}

export function precisionSummary(classifications = []) {
  const states = Object.fromEntries(WORK_STATES.map((value) => [value, 0]));
  const actors = Object.fromEntries(NEXT_ACTORS.map((value) => [value, 0]));
  const priorities = Object.fromEntries(PRIORITIES.map((value) => [value, 0]));
  let reviewRequired = 0;
  let assignedProjects = 0;
  for (const item of classifications) {
    if (Object.hasOwn(states, item.workState)) states[item.workState] += 1;
    if (Object.hasOwn(actors, item.nextActor)) actors[item.nextActor] += 1;
    if (Object.hasOwn(priorities, item.priority)) priorities[item.priority] += 1;
    if (item.reviewStatus === 'review_required' || item.workState === 'review_required') reviewRequired += 1;
    if (item.projectResolution === 'confirmed') assignedProjects += 1;
  }
  return {
    total: classifications.length,
    states,
    actors,
    priorities,
    reviewRequired,
    assignedProjects,
    unassignedProjects: classifications.length - assignedProjects,
  };
}
