const SIGNALS = {
  urgent: /긴급|오늘\s*중|금일\s*중|즉시|마감|장애|critical|urgent|asap|eod/i,
  waiting: /회신\s*대기|승인\s*대기|자료\s*대기|상대방\s*확인|pending approval|waiting for|awaiting/i,
  done: /완료|종료|처리했습니다|발송했습니다|해결했습니다|resolved|completed|done|closed/i,
  active: /진행\s*(중|필요|예정)|준비\s*(필요|부탁|요청)|검토\s*(필요|부탁|요청)|작성\s*(필요|부탁|요청)|수정\s*(필요|부탁|요청)|제출\s*(필요|부탁|요청)|follow.?up|in progress|please|need/i,
};

const NO_ACTION_PATTERN = /별도\s*(조치|회신|답변|확인).{0,8}(필요\s*(없|하지)|불필요)|추가\s*(조치|회신|답변).{0,8}(필요\s*(없|하지)|불필요|없습니다)|회신\s*(불필요|필요\s*없)|참고\s*(용|바랍니다|해\s*주세요)|단순\s*공지|뉴스레터|newsletter|unsubscribe|수신거부|\bfyi\b|for your information/i;
const REQUEST_PATTERN = /부탁|요청|회신|답변|검토|승인|준비|수정|작성|발송|제출|공유\s*해|전달\s*해|확인\s*(부탁|해)|please|need|confirm|review|send|approve|schedule|follow.?up/i;
const OWNER_PATTERN = /(담당|owner|pic)\s*[:：]\s*([^\n,]+)/i;
const DATE_PATTERN = /(\d{4}[.-]\d{1,2}[.-]\d{1,2}|\d{1,2}\/\d{1,2}|오늘|내일|금일|이번\s*주|다음\s*주|월요일|화요일|수요일|목요일|금요일|오전\s*\d{1,2}시|오후\s*\d{1,2}시|\d{1,2}시)/g;

export function generateDemoMailText() {
  return `Subject: [Acme] HCI 제안서 최종본 및 PoC 일정 확인
From: 김현우 <hwkim@acme.example.com>
Date: 2026-05-18 09:20

오늘 중으로 HCI 제안서 최종본 공유 부탁드립니다. 고객 내부 검토가 내일 오전에 예정되어 있어 일정이 촉박합니다.
담당: 박재민

PoC 장비 반입 일정은 2026-05-21 오후 2시로 확정되었습니다. 방화벽 정책표는 고객 보안팀 승인 대기 상태입니다.`;
}

function currentMessageBody(value = '') {
  const lines = String(value || '').replace(/\r/g, '').split('\n');
  const markerIndex = lines.findIndex((line, index) => {
    if (index === 0) return false;
    const trimmed = line.trim();
    return /^-{2,}\s*(original message|원본 메시지)\s*-{2,}$/i.test(trimmed)
      || /^_{5,}$/.test(trimmed)
      || /^(보낸 사람|발신|from)\s*:/i.test(trimmed)
      || /^on\s.+wrote:\s*$/i.test(trimmed)
      || /^>+\s*/.test(trimmed);
  });
  return (markerIndex >= 0 ? lines.slice(0, markerIndex) : lines).join('\n').trim();
}

function messageToText(message) {
  return [
    `Subject: ${message.subject || '(제목 없음)'}`,
    `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from || 'unknown'}`,
    `Date: ${message.receivedAt || ''}`,
    currentMessageBody(message.body || message.bodyPreview || ''),
  ].filter(Boolean).join('\n');
}

function splitCandidates(text) {
  return String(text || '')
    .split(/\n+|(?<=[.!?。])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 6)
    .filter((line) => !/^subject:|^from:|^date:/i.test(line));
}

function hasConcreteRequest(text) {
  const value = String(text || '');
  if (!REQUEST_PATTERN.test(value)) return false;
  if (!NO_ACTION_PATTERN.test(value)) return true;
  return value
    .split(/하지만|다만|그러나|but|however|[.;。]/i)
    .some((clause) => !NO_ACTION_PATTERN.test(clause) && REQUEST_PATTERN.test(clause));
}

function hasDate(text) {
  DATE_PATTERN.lastIndex = 0;
  return DATE_PATTERN.test(text);
}

function inferLane(line, message = {}) {
  const text = String(line || '');
  const noAction = NO_ACTION_PATTERN.test(text);
  const requested = hasConcreteRequest(text);
  const urgent = SIGNALS.urgent.test(text);
  const waiting = SIGNALS.waiting.test(text);
  const done = SIGNALS.done.test(text);
  const active = SIGNALS.active.test(text) || requested || hasDate(text);

  // Explicit no-action language is authoritative unless the same sentence
  // contains a concrete contradictory request.
  if (noAction && !requested) {
    if (waiting) return 'waiting';
    if (done) return 'done';
    return 'reference';
  }

  // Present/future urgent work must outrank historical completion language.
  if (urgent && (requested || active)) return 'urgent';
  // Explicit waiting language (for example, "승인 대기") describes the
  // current work state even when the same phrase contains a generic request
  // keyword such as "승인".
  if (waiting) return 'waiting';
  if (requested || active) {
    if (message.importance === 'high') return 'urgent';
    return 'active';
  }
  if (waiting) return 'waiting';
  if (done) return 'done';
  return 'reference';
}

function inferOwner(line) {
  return line.match(OWNER_PATTERN)?.[2]?.trim() || '미지정';
}

function inferDates(line) {
  DATE_PATTERN.lastIndex = 0;
  return Array.from(String(line).matchAll(DATE_PATTERN)).map((match) => match[0]);
}

function titleFrom(line) {
  return String(line)
    .replace(/^subject:\s*/i, '')
    .replace(/담당\s*[:：]\s*[^\n,]+/i, '')
    .trim()
    .slice(0, 96);
}

function normalizeBody(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function summaryBullets(message) {
  const body = normalizeBody(currentMessageBody(message.body || message.bodyPreview || ''));
  const sentences = body
    .split(/(?<=[.!?。])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const useful = sentences.filter((sentence) => REQUEST_PATTERN.test(sentence) || hasDate(sentence) || SIGNALS.waiting.test(sentence));
  return (useful.length ? useful : sentences).slice(0, 3).map((sentence) => sentence.slice(0, 180));
}

function priorityFor(lane, dates = []) {
  if (lane === 'urgent') return 1;
  if (dates.length > 0) return 2;
  if (lane === 'waiting') return 3;
  if (lane === 'active') return 4;
  if (lane === 'done') return 5;
  return 6;
}

function toTask(line, index, message) {
  const dates = inferDates(line);
  const lane = inferLane(line, message);
  return {
    id: `task-${index}`,
    lane,
    title: titleFrom(line),
    body: line,
    owner: inferOwner(line),
    dates,
    source: 'body',
    messageId: message?.id,
    subject: message?.subject,
    from: message?.from,
    receivedAt: message?.receivedAt,
    webLink: message?.webLink,
    priority: priorityFor(lane, dates),
  };
}

function statusForMessage(message, tasks) {
  const body = `${message.subject || ''} ${currentMessageBody(message.body || message.bodyPreview || '')}`;
  const requested = hasConcreteRequest(body);
  if (NO_ACTION_PATTERN.test(body) && !requested) {
    if (SIGNALS.waiting.test(body)) return 'waiting';
    if (SIGNALS.done.test(body)) return 'done';
    return 'reference';
  }
  for (const lane of ['urgent', 'waiting', 'active', 'done']) {
    if (tasks.some((task) => task.lane === lane)) return lane;
  }
  return 'reference';
}

function replySubject(subject = '') {
  return /^re:/i.test(subject) ? subject : `RE: ${subject || '(제목 없음)'}`;
}

function emailAddress(value = '') {
  return String(value).match(/<([^>]+)>/)?.[1]?.trim() || String(value).trim();
}

function recommendedAction(status, dates = []) {
  if (status === 'urgent') return dates.length ? `감지된 기한(${dates.join(', ')}) 전에 요청을 처리하고 회신` : '긴급 요청의 담당자와 완료 시각을 확정하고 회신';
  if (status === 'waiting') return '상대방 회신·승인 상태를 확인하고 필요한 시점에 리마인드';
  if (status === 'active') return dates.length ? `감지된 기한(${dates.join(', ')})에 맞춰 처리 계획을 회신` : '요청 내용을 검토하고 담당자·처리 일정을 회신';
  if (status === 'done') return '완료 상태를 기록하고 추가 요청이 있는지만 모니터링';
  return '참고 정보로 보관하고 별도 회신은 하지 않음';
}

function primaryActionForMessage(message, status, tasks, summaries) {
  const dates = [...new Set(tasks.flatMap((task) => task.dates))];
  const owner = tasks.find((task) => task.owner !== '미지정')?.owner || '미지정';
  const evidence = tasks.find((task) => task.lane === status)?.body || summaries[0] || message.bodyPreview || '';
  const action = recommendedAction(status, dates);
  const base = {
    id: `primary-${message.id}`,
    scenario: 1,
    title: status === 'reference' ? '참고로 보관' : status === 'waiting' ? '대기 상태 확인' : status === 'done' ? '완료 상태 모니터링' : '추천 처리',
    intent: '메일의 현재 상태와 근거에 따른 기본 추천 행동입니다.',
    recommendedAction: action,
    owner,
    priority: priorityFor(status, dates),
    lane: status,
    due: dates.join(', '),
    evidence,
    subject: message.subject,
    messageId: message.id,
    receivedAt: message.receivedAt,
    webLink: message.webLink,
  };

  if (status === 'reference' || status === 'done' || status === 'waiting') {
    return {
      ...base,
      actionType: status === 'reference' ? 'archive' : 'monitor',
      to: '',
      mailSubject: '',
      body: '',
    };
  }

  const recipient = emailAddress(message.from || '');
  const summaryText = (summaries.length ? summaries : [message.bodyPreview || message.subject || '메일 내용을 확인했습니다.'])
    .slice(0, 3)
    .map((item) => `- ${item}`)
    .join('\n');
  return {
    ...base,
    actionType: 'draft_reply',
    to: recipient,
    mailSubject: replySubject(message.subject),
    body: `안녕하세요.\n\n메일 내용 확인했습니다.\n\n핵심 내용은 아래와 같이 이해했습니다.\n${summaryText}\n\n다음과 같이 진행하겠습니다.\n- ${action}\n\n진행 상황을 다시 공유드리겠습니다.\n\n감사합니다.`,
  };
}

export function analyzeMail(text) {
  return analyzeMessages([{ id: 'mail-text', subject: '(직접 입력)', from: '', body: text, bodyPreview: text }]);
}

export function analyzeMessages(messages = []) {
  const allTasks = [];
  const messageInsights = messages.map((message, messageIndex) => {
    const tasks = splitCandidates(messageToText(message))
      .map((line, lineIndex) => toTask(line, `${messageIndex}-${lineIndex}`, message))
      .filter((task) => task.title);
    allTasks.push(...tasks);
    const summaries = summaryBullets(message);
    const status = statusForMessage(message, tasks);
    const dates = [...new Set(tasks.flatMap((task) => task.dates))];
    const nextActions = [primaryActionForMessage(message, status, tasks, summaries)];
    return {
      id: message.id,
      subject: message.subject,
      from: message.from,
      fromName: message.fromName,
      receivedAt: message.receivedAt,
      importance: message.importance,
      isRead: message.isRead,
      webLink: message.webLink,
      bodyPreview: message.bodyPreview || normalizeBody(message.body || '').slice(0, 260),
      summary: summaries.length ? summaries : ['요약할 본문이 부족합니다. 원문을 확인하세요.'],
      evidenceItems: tasks.filter((task) => task.lane !== 'reference').map((task) => task.body).slice(0, 5),
      aiRationale: '',
      aiEnhanced: false,
      analysisSource: 'rules',
      tasks,
      nextActions,
      dates,
      status,
    };
  });

  const nextActions = messageInsights.flatMap((insight) => insight.nextActions).sort((a, b) => a.priority - b.priority);
  const calendar = allTasks
    .filter((task) => task.dates.length > 0 && task.lane !== 'reference')
    .map((task) => ({
      title: task.title,
      when: task.dates.join(', '),
      owner: task.owner,
      lane: task.lane,
      subject: task.subject,
      messageId: task.messageId,
      receivedAt: task.receivedAt,
      webLink: task.webLink,
    }));
  const reminders = nextActions
    .filter((action) => action.lane === 'urgent' || action.lane === 'waiting' || action.due)
    .map((action) => ({
      title: action.recommendedAction,
      reason: action.evidence,
      owner: action.owner,
      subject: action.subject,
      messageId: action.messageId,
      receivedAt: action.receivedAt,
      webLink: action.webLink,
    }));

  return {
    tasks: allTasks,
    calendar,
    reminders,
    nextActions,
    messageInsights,
    counts: Object.fromEntries(['urgent', 'active', 'waiting', 'done', 'reference'].map((lane) => [lane, messageInsights.filter((item) => item.status === lane).length])),
  };
}
