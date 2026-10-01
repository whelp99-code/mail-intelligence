export const DISPLAY_LABELS = Object.freeze({
  do_now: '지금 처리',
  waiting: '대기',
  review: '검토',
  archive: '보관',
  'DO NOW': '지금 처리',
  WAITING: '대기',
  REVIEW: '검토',
  ARCHIVE: '보관',
  'Precision Classification': '정밀 분류',
  'Operational Lane': '업무 구분',
  'Operational Classification': '운영 분류',
  'Authoritative Storage': '기준 저장소',
  Search: '검색',
  critical: '최우선',
  high: '높음',
  normal: '보통',
  low: '낮음',
});

const FORBIDDEN_VISIBLE = Object.freeze([
  'DO NOW',
  'WAITING',
  'REVIEW',
  'ARCHIVE',
  'Precision Classification',
  'Operational Lane',
  'Operational Classification',
]);

export function operationalLaneLabel(value) {
  return DISPLAY_LABELS[value] || DISPLAY_LABELS.review;
}

export function priorityLabel(value) {
  return DISPLAY_LABELS[value] || DISPLAY_LABELS.normal;
}

export function displayLabel(value) {
  return DISPLAY_LABELS[value] || String(value ?? '');
}

export function renderOperationalDetail(lane = 'review') {
  return `<section class="operational-detail"><span class="memory-label">${DISPLAY_LABELS['Operational Lane']}</span><strong>${operationalLaneLabel(lane)}</strong></section>`;
}

export function renderLaneFilterLabels() {
  return ['do_now', 'waiting', 'review', 'archive']
    .map((lane) => `<span>${operationalLaneLabel(lane)}</span>`)
    .join('');
}

export function renderDetailMetaImportance(importance = 'normal') {
  return priorityLabel(importance);
}

export function renderStoredPrecisionStatus({ total = 0, lanes = {}, review = 0 } = {}) {
  return `저장 전체 정밀 분류 ${total}건 · ${operationalLaneLabel('do_now')} ${lanes.do_now || 0} · ${operationalLaneLabel('waiting')} ${lanes.waiting || 0} · ${operationalLaneLabel('review')} ${lanes.review || review} · ${operationalLaneLabel('archive')} ${lanes.archive || 0}`;
}

export function renderPrecisionStayNote() {
  return `애매한 판단은 ${operationalLaneLabel('review')}에 남깁니다.`;
}

export function containsForbiddenVisibleLabel(text) {
  const source = String(text || '');
  return FORBIDDEN_VISIBLE.some((label) => source.includes(label))
    || /(?:^|[^\w])normal(?:[^\w]|$)/.test(source);
}

const BLOCKED_WRITES = '메일 이동·삭제·읽음 처리·캘린더·CRM 자동 쓰기는 차단';

export function safetyBannerCopy(health = {}) {
  const safety = health?.safety && typeof health.safety === 'object' ? health.safety : {};
  const capabilities = {
    ...(safety.capabilities || {}),
    ...(health?.capabilities || {}),
  };
  const version = 'v' + String(health?.version || safety.version || '1.2.2').replace(/^v/, '');
  const sendOn = safety.mode === 'human-approved-mail-send'
    || capabilities.mailSend === true
    || capabilities.send === true;
  if (sendOn) {
    return {
      title: version + ' 승인 후 발송 모드',
      body: '초안은 자동 작성, 발송은 대표 승인 후에만. ' + BLOCKED_WRITES + '.',
    };
  }
  return {
    title: version + ' 읽기 전용 운영 안정화',
    body: '초안은 복사만 가능하며 메일 발송·원본 변경·캘린더·CRM 자동 쓰기는 차단됩니다.',
  };
}
