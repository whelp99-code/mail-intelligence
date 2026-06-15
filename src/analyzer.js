const STATUS_RULES = [
  { lane: 'done', patterns: [/완료|종료|처리했습니다|발송했습니다|resolved|completed|done/i] },
  { lane: 'waiting', patterns: [/대기|회신\s*대기|승인\s*대기|확인\s*부탁|waiting|pending approval/i] },
  { lane: 'urgent', patterns: [/긴급|오늘\s*중|금일\s*중|마감|장애|critical|urgent|asap/i] },
  { lane: 'active', patterns: [/진행|준비|검토|작성|공유|follow.?up|in progress|review/i] }
];

const OWNER_PATTERN = /(담당|owner|pic)\s*[:：]\s*([^\n,]+)/i;
const DATE_PATTERN = /(\d{4}[.-]\d{1,2}[.-]\d{1,2}|\d{1,2}\/\d{1,2}|오늘|내일|금일|이번\s*주|다음\s*주|월요일|화요일|수요일|목요일|금요일)/g;
const ACTION_PATTERN = /부탁|요청|확인|공유|회신|답변|검토|승인|준비|발송|전달|일정|마감|need|please|confirm|review|share|send|approve|schedule|follow/i;

export function generateDemoMailText() {
  return `Subject: [Acme] HCI 제안서 최종본 및 PoC 일정 확인
From: 김현우 <hwkim@acme.example.com>
Date: 2026-05-18 09:20

오늘 중으로 HCI 제안서 최종본 공유 부탁드립니다. 고객 내부 검토가 내일 오전에 예정되어 있어 일정이 촉박합니다.
담당: 박재민

PoC 장비 반입 일정은 2026-05-21 오후 2시로 확정되었습니다. 방화벽 정책표는 고객 보안팀 승인 대기 상태입니다.

지난주 요청한 라이선스 견적은 발송 완료했습니다. 회신을 받으면 계약 조건 검토를 진행하겠습니다.

Subject: [Globex] ERP Forecast Sync 후속
From: Sarah Lee <sarah@globex.example.com>
Date: 2026-05-17 16:40

다음 주 화요일까지 데이터 샘플을 공유해 주세요. API 권한은 내부 승인 대기 중입니다.
긴급 이슈는 아니지만 일정 지연 가능성이 있어 리마인드가 필요합니다.`;
}

function messageToText(message) {
  return [
    `Subject: ${message.subject || '(제목 없음)'}`,
    `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from || 'unknown'}`,
    `Date: ${message.receivedAt || ''}`,
    message.body || message.bodyPreview || ''
  ].filter(Boolean).join('\n');
}

function splitCandidates(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 8)
    .filter((line) => !/^subject:|^from:|^date:/i.test(line));
}

function inferLane(line) {
  for (const rule of STATUS_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(line))) return rule.lane;
  }
  return 'active';
}

function inferOwner(line) {
  const match = line.match(OWNER_PATTERN);
  return match?.[2]?.trim() || '미지정';
}

function inferDates(line) {
  return Array.from(line.matchAll(DATE_PATTERN)).map((match) => match[0]);
}

function titleFrom(line) {
  return line
    .replace(/^subject:\s*/i, '')
    .replace(/담당\s*[:：]\s*[^\n,]+/i, '')
    .trim()
    .slice(0, 96);
}

function normalizeBody(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function summaryBullets(message) {
  const body = normalizeBody(message.body || message.bodyPreview || '');
  const withoutHeaders = body.replace(/Subject:\s*.+?(?=From:|Date:|$)/gi, '').replace(/From:\s*.+?(?=Date:|$)/gi, '').replace(/Date:\s*.+?(?=\s|$)/gi, '');
  const sentences = withoutHeaders.split(/(?<=[.!?。]|다\.|요\.)\s+/).map((item) => item.trim()).filter(Boolean);
  const useful = sentences.filter((sentence) => ACTION_PATTERN.test(sentence) || DATE_PATTERN.test(sentence));
  return (useful.length ? useful : sentences).slice(0, 3).map((sentence) => sentence.slice(0, 180));
}

function isActionLike(line) {
  return ACTION_PATTERN.test(line) || DATE_PATTERN.test(line) || /^subject:/i.test(line);
}

function priorityFor(task) {
  if (task.lane === 'urgent') return 1;
  if (task.dates.length > 0) return 2;
  if (task.lane === 'waiting') return 3;
  if (task.lane === 'active') return 4;
  return 5;
}

function recommendedAction(task) {
  if (task.lane === 'done') return '완료로 기록하고 관련 스레드만 모니터링';
  if (task.lane === 'waiting') return '상대방 회신/승인 여부를 확인하고 필요 시 리마인드 발송';
  if (task.lane === 'urgent') return '오늘 처리할 담당자와 마감 시간을 확정';
  if (task.dates.length > 0) return '캘린더 일정 또는 리마인더로 등록';
  return '담당자와 다음 진행 상태를 업데이트';
}

function replySubject(subject = '') {
  return /^re:/i.test(subject) ? subject : `RE: ${subject || '(제목 없음)'}`;
}

function emailAddress(value = '') {
  return String(value).match(/<([^>]+)>/)?.[1]?.trim() || String(value).trim();
}

function actionScenariosForMessage(message, primaryActions = [], summaries = []) {
  const recipient = emailAddress(message.from || '');
  const subject = replySubject(message.subject);
  const primary = primaryActions[0];
  const evidence = primary?.evidence || summaries[0] || message.bodyPreview || '';
  const summaryText = summaries.slice(0, 3).map((item) => `- ${item}`).join('\n') || '- 메일 내용을 확인했습니다.';
  const senderName = message.fromName || '담당자';
  const sangforReference = '필요 시 Sangfor VDI/HCI 소개자료, 구축 메뉴얼, 기존 발송자료를 함께 확인해 정확한 버전과 링크를 첨부하세요.';
  const messageText = `${message.subject || ''} ${message.body || message.bodyPreview || ''}`.toLowerCase();
  const lane = primary?.lane || 'active';
  const asksForInfo = /문의|확인|요청|부탁|가능|견적|회신|질문|검토/.test(messageText);
  const hasAttachmentContext = Boolean(message.hasAttachments || message.attachmentNames?.length);
  const hasDateContext = Boolean(primary?.due || /오늘|내일|금일|이번 주|다음 주|\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(messageText));

  const primaryTitle =
    lane === 'urgent' ? '긴급 우선 회신'
    : lane === 'waiting' ? '대기 사유 정리 회신'
    : lane === 'done' ? '완료 사실 공유'
    : asksForInfo ? '요청 사항 확인 회신' : '진행 상태 공유';
  const primaryBodyLine =
    lane === 'urgent' ? '우선순위를 높여 바로 확인하고 처리 순서를 회신드리겠습니다.'
    : lane === 'waiting' ? '현재 대기 중인 항목과 추가로 필요한 정보를 정리해 회신드리겠습니다.'
    : lane === 'done' ? '현재 기준으로 완료된 항목과 남은 확인 포인트만 간단히 공유드립니다.'
    : hasDateContext ? '요청하신 일정 기준으로 진행 가능 여부와 내부 일정을 정리해 회신드리겠습니다.'
    : '요청하신 내용을 기준으로 다음 단계와 필요한 확인 사항을 정리해 회신드리겠습니다.';

  const clarificationTitle = hasDateContext ? '일정/범위 재확인' : '추가 정보 요청';
  const clarificationAction = hasDateContext
    ? '마감 시점, 적용 범위, 우선순위를 다시 확인'
    : '진행 전 필요한 조건, 일정, 담당자, 범위를 추가 확인';

  const referenceTitle = hasAttachmentContext ? '첨부자료 기준 회신' : '자료 공유 및 미팅 제안';
  const referenceAction = hasAttachmentContext
    ? '첨부파일과 기존 발송자료를 기준으로 필요한 파일만 선별해 회신'
    : 'Sangfor 관련 자료 확인 후 공유하고 필요 시 설명 미팅 제안';

  return [
    {
      id: `scenario-1-${message.id}`,
      scenario: 1,
      title: primaryTitle,
      intent: '상대 요청을 수락하고 우리가 진행할 다음 단계를 명확히 알립니다.',
      recommendedAction: primary?.recommendedAction || '요청 사항을 확인하고 처리 예정 일정을 회신',
      owner: primary?.owner || '미지정',
      priority: primary?.priority || 3,
      lane: primary?.lane || 'active',
      due: primary?.due || '',
      evidence,
      to: recipient,
      subject,
      body: `안녕하세요, ${senderName}님.\n\n메일 내용 확인했습니다.\n\n핵심 내용은 아래와 같이 이해했습니다.\n${summaryText}\n\n현재 기준 다음과 같이 진행하겠습니다.\n- ${primary?.recommendedAction || primaryBodyLine}\n\n추가 확인이 필요한 내용이 있으면 함께 반영해 회신드리겠습니다.\n\n감사합니다.`
    },
    {
      id: `scenario-2-${message.id}`,
      scenario: 2,
      title: clarificationTitle,
      intent: '판단에 필요한 정보가 부족할 때 누락 정보를 요청합니다.',
      recommendedAction: clarificationAction,
      owner: '미지정',
      priority: 4,
      lane: 'waiting',
      due: '',
      evidence,
      to: recipient,
      subject,
      body: `안녕하세요, ${senderName}님.\n\n메일 내용 확인했습니다. 정확히 진행하기 위해 아래 사항을 추가로 확인 부탁드립니다.\n\n1. 요청 범위 또는 대상 시스템\n2. 희망 일정 및 마감 시점\n3. 관련 담당자 또는 승인 필요 여부\n\n현재 확인한 내용:\n${summaryText}\n\n확인 주시면 그 기준으로 다음 단계 진행하겠습니다.\n\n감사합니다.`
    },
    {
      id: `scenario-3-${message.id}`,
      scenario: 3,
      title: referenceTitle,
      intent: 'Sangfor 자료, 매뉴얼, 관련 문서를 근거로 공유하거나 설명 일정을 제안합니다.',
      recommendedAction: referenceAction,
      owner: '미지정',
      priority: 4,
      lane: 'active',
      due: '',
      evidence: hasAttachmentContext
        ? `기존 첨부파일 및 관련 발송자료를 우선 검토하세요. ${sangforReference}`
        : sangforReference,
      to: recipient,
      subject,
      body: hasAttachmentContext
        ? `안녕하세요, ${senderName}님.\n\n관련 첨부파일과 기존 발송자료를 기준으로 필요한 문서만 정리해 공유드리겠습니다.\n\n메일에서 확인한 핵심 내용:\n${summaryText}\n\n파일 버전과 전달 범위를 확인한 뒤 다시 회신드리겠습니다.\n\n감사합니다.`
        : `안녕하세요, ${senderName}님.\n\n문의 주신 내용과 관련해 Sangfor 자료 및 관련 문서를 확인한 뒤 공유드리겠습니다.\n\n우선 확인할 자료 범위는 아래와 같습니다.\n- Sangfor 제품/기능 소개 페이지\n- 구축 또는 운영 메뉴얼\n- 기존 발송자료 및 관련 제안 문서\n\n메일에서 확인한 핵심 내용:\n${summaryText}\n\n자료 확인 후 필요 시 짧은 설명 미팅도 함께 제안드리겠습니다.\n\n감사합니다.`
    }
  ];
}

function toTask(line, index, message) {
  const dates = inferDates(line);
  const inferredLane = inferLane(line);
  const lane = message?.importance === 'high' && inferredLane !== 'done' ? 'urgent' : inferredLane;
  const task = {
    id: `task-${index}`,
    lane,
    title: titleFrom(line),
    body: line,
    owner: inferOwner(line),
    dates,
    source: line.toLowerCase().startsWith('subject:') ? 'subject' : 'body',
    messageId: message?.id,
    subject: message?.subject,
    from: message?.from,
    receivedAt: message?.receivedAt,
    webLink: message?.webLink,
    priority: 0,
    recommendedAction: ''
  };
  task.priority = priorityFor(task);
  task.recommendedAction = recommendedAction(task);
  return task;
}

export function analyzeMail(text) {
  const candidates = splitCandidates(text);
  const tasks = candidates.map(toTask).filter((task) => task.title && isActionLike(task.body));
  return summarizeTasks(tasks, []);
}

export function analyzeMessages(messages) {
  const tasks = messages.flatMap((message, messageIndex) => splitCandidates(messageToText(message))
    .map((line, lineIndex) => toTask(line, `${messageIndex}-${lineIndex}`, message))
    .filter((task) => task.title && isActionLike(task.body)));
  return summarizeTasks(tasks, messages);
}

function summarizeTasks(tasks, messages) {
  const calendar = tasks
    .filter((task) => task.dates.length > 0)
    .map((task) => ({
      title: task.title,
      when: task.dates.join(', '),
      owner: task.owner,
      lane: task.lane,
      subject: task.subject,
      messageId: task.messageId,
      receivedAt: task.receivedAt,
      webLink: task.webLink
    }));

  const nextActions = [...tasks]
    .filter((task) => task.lane !== 'done')
    .sort((a, b) => a.priority - b.priority || String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .slice(0, 12)
    .map((task) => ({
      id: `action-${task.id}`,
      title: task.title,
      owner: task.owner,
      priority: task.priority,
      lane: task.lane,
      due: task.dates.join(', '),
      recommendedAction: task.recommendedAction,
      evidence: task.body,
      subject: task.subject,
      messageId: task.messageId,
      receivedAt: task.receivedAt,
      webLink: task.webLink
    }));

  const reminders = tasks
    .filter((task) => task.lane === 'urgent' || task.lane === 'waiting' || task.dates.length > 0)
    .map((task) => ({
      title: task.lane === 'waiting' ? `${task.title} 회신/승인 확인` : `${task.title} 리마인드`,
      reason: task.lane === 'urgent' ? '긴급 표현이 감지되었습니다.' : task.dates.length ? '일정 표현이 포함되어 있습니다.' : '대기 상태로 분류되었습니다.',
      owner: task.owner,
      subject: task.subject,
      messageId: task.messageId,
      receivedAt: task.receivedAt,
      webLink: task.webLink
    }));

  const messageInsights = messages.map((message) => {
    const messageTasks = tasks.filter((task) => task.messageId === message.id);
    const summaries = summaryBullets(message);
    const fallbackAction = {
      id: `action-review-${message.id}`,
      title: message.subject,
      owner: '미지정',
      priority: 6,
      lane: 'active',
      due: '',
      recommendedAction: summaries.length ? '요약을 확인하고 후속 필요 여부를 판단' : '업무 액션 없음. 참고 또는 보관 후보',
      evidence: summaries[0] || message.bodyPreview || message.subject || '',
      subject: message.subject,
      messageId: message.id,
      receivedAt: message.receivedAt,
      webLink: message.webLink
    };
    const messageNextActions = nextActions.filter((action) => action.messageId === message.id);
    const normalizedActions = actionScenariosForMessage(
      message,
      messageNextActions.length ? messageNextActions : [fallbackAction],
      summaries
    );
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
      evidenceItems: messageTasks.map((task) => task.body).slice(0, 5),
      aiRationale: '',
      aiEnhanced: false,
      tasks: messageTasks,
      nextActions: normalizedActions,
      dates: [...new Set(messageTasks.flatMap((task) => task.dates))],
      status: messageTasks.some((task) => task.lane === 'urgent') ? 'urgent'
        : messageTasks.some((task) => task.lane === 'waiting') ? 'waiting'
          : messageTasks.some((task) => task.lane === 'active') ? 'active'
            : messageTasks.some((task) => task.lane === 'done') ? 'done' : 'reference'
    };
  });

  return {
    tasks,
    calendar,
    reminders,
    nextActions,
    messageInsights,
    counts: {
      urgent: tasks.filter((task) => task.lane === 'urgent').length,
      active: tasks.filter((task) => task.lane === 'active').length,
      waiting: tasks.filter((task) => task.lane === 'waiting').length,
      done: tasks.filter((task) => task.lane === 'done').length
    }
  };
}
