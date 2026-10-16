import { operationalLaneLabel, priorityLabel } from '../ui-labels.js';

/** Visible analysis slots. One value each. Calculation stays in the classifier. */
export const ANALYSIS_FIELDS = Object.freeze([
  {
    key: 'status',
    name: '처리 상태',
    values: Object.freeze(['지금 처리', '대기', '검토', '보관']),
    meaning: '지금 이 메일을 어느 함에 둘지',
    decidedBy: '운영 규칙. 사람이 보정하면 보정이 우선',
  },
  {
    key: 'next',
    name: '다음 행동',
    values: Object.freeze(['내 차례', '내부 팀 차례', '고객·외부 차례', '공동 대응', '다음 행동 없음', '행동 주체 불명']),
    meaning: '다음에 누가 움직이나',
    decidedBy: '운영 규칙. 정밀 분류 보정으로 바꿀 수 있음',
  },
  {
    key: 'urgency',
    name: '긴급도',
    values: Object.freeze(['최우선', '높음', '보통', '낮음']),
    meaning: '얼마나 급한가',
    decidedBy: '운영 규칙',
  },
  {
    key: 'kind',
    name: '분류',
    values: Object.freeze(['내 행동 필요', '결정 필요', '완료', '참고', '검토 필요']),
    meaning: '일의 종류. 처리 상태와 같은 말인 대기는 여기서 빼 한 번만 보여 줌',
    decidedBy: '운영 규칙. 정밀 분류 보정으로 바꿀 수 있음',
  },
  {
    key: 'project',
    name: '연결 프로젝트',
    values: Object.freeze(['등록된 프로젝트명', '프로젝트 미연결']),
    meaning: 'CRM에 등록된 프로젝트 이름. 후보는 이름이 아님',
    decidedBy: 'CRM 등록. 메일은 읽기만 함',
  },
]);

const NEXT_ACTION = Object.freeze({
  me: '내 차례',
  internal_team: '내부 팀 차례',
  external_party: '고객·외부 차례',
  shared: '공동 대응',
  none: '다음 행동 없음',
  unknown: '행동 주체 불명',
});

const KIND = Object.freeze({
  action_required: '내 행동 필요',
  waiting: '대기',
  decision_required: '결정 필요',
  completed: '완료',
  reference: '참고',
  review_required: '검토 필요',
});

export const UNLINKED_PROJECT = '프로젝트 미연결';

export function nextActionLabel(value) {
  return NEXT_ACTION[value] || NEXT_ACTION.unknown;
}

export function classificationLabel(value) {
  return KIND[value] || KIND.review_required;
}

function registeredLinkName(link) {
  if (!link || link.objectType !== 'engagement') return '';
  if (link.status === 'candidate' || link.registered === false) return '';
  if (link.registered !== true && link.status !== 'linked' && link.status !== 'active') return '';
  return String(link.name || '').trim();
}

/** CRM read result or a confirmed project name. Candidates stay unlinked. */
export function registeredProjectName(classification, links = []) {
  for (const link of links || []) {
    const name = registeredLinkName(link);
    if (name) return name;
  }
  if (classification?.projectResolution === 'confirmed') {
    const name = String(classification.projectName || classification.projectKey || '').trim();
    if (name) return name;
  }
  return UNLINKED_PROJECT;
}

export function analysisValues(classification, links = []) {
  const status = operationalLaneLabel(classification?.operational?.lane);
  const next = nextActionLabel(classification?.nextActor);
  const urgency = priorityLabel(classification?.priority);
  const kind = classificationLabel(classification?.workState);
  return {
    status,
    next,
    urgency,
    kind: kind && kind !== status ? kind : '',
    project: registeredProjectName(classification, links),
  };
}

export function analysisLine(classification, links = []) {
  if (!classification) return '정밀 분류 전';
  const values = analysisValues(classification, links);
  const parts = [
    `처리 상태 ${values.status}`,
    `다음 행동 ${values.next}`,
    `긴급도 ${values.urgency}`,
  ];
  if (values.kind) parts.push(`분류 ${values.kind}`);
  parts.push(`프로젝트 ${values.project}`);
  return parts.join(' · ');
}

/** Same registered project and the same conversation are one thread. */
export function threadKey(message, classification, links = []) {
  const conversation = String(message?.conversationId || '').trim();
  if (!conversation) return '';
  return `${registeredProjectName(classification, links)}\n${conversation}`;
}
