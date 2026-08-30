const SANGFOR_TOPIC_PATTERN = /sangfor|상포|\bndr\b|\bsta\b|\bepp\b|\biag\b|\bhci\b|\bvdi\b|cybershield|secure access|매뉴얼|메뉴얼/i;

function replySubject(subject = '') {
  return /^re:/i.test(subject) ? subject : `RE: ${subject || '(제목 없음)'}`;
}

export function buildSangforActions({ message = {}, summaries = [], evidence = '' } = {}) {
  const source = `${message.subject || ''} ${message.body || ''} ${message.bodyPreview || ''}`;
  if (!SANGFOR_TOPIC_PATTERN.test(source)) return [];

  const summaryText = (summaries.length ? summaries : [message.bodyPreview || message.subject || '문의 내용을 확인했습니다.'])
    .slice(0, 3)
    .map((item) => `- ${item}`)
    .join('\n');

  return [{
    id: `profile-sangfor-${message.id || 'message'}`,
    scenario: 'domain-profile',
    title: 'Sangfor 근거자료 확인',
    intent: '제품·버전·구성에 맞는 공식 자료를 확인한 뒤 근거 기반으로 답변합니다.',
    recommendedAction: '관련 Sangfor 제품·버전과 공식 매뉴얼을 확인하고 검증된 자료만 회신 초안에 반영',
    owner: '미지정',
    priority: 4,
    lane: 'active',
    due: '',
    evidence: evidence || '제품명·버전·요청 범위를 원문과 공식 자료에서 교차 확인해야 합니다.',
    to: message.from || '',
    mailSubject: replySubject(message.subject),
    body: `안녕하세요.\n\n문의 내용을 확인했습니다.\n\n현재 파악한 내용은 아래와 같습니다.\n${summaryText}\n\n정확한 답변을 위해 해당 Sangfor 제품과 버전의 공식 매뉴얼 및 기존 검증 자료를 확인하겠습니다. 확인되지 않은 기능이나 수치는 확정해서 안내하지 않고, 근거가 확인된 내용만 정리해 회신드리겠습니다.\n\n감사합니다.`
  }];
}
