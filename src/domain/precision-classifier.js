import { createHash } from 'node:crypto';

import {
  decisionFromMailEventFrame,
  extractMailEventFrame,
  isPriorityBoilerplate,
  MAIL_EVENT_FRAME_VERSION,
} from './mail-event-extractor.js';
import {
  deriveOperationalClassification,
  operationalSummary,
} from './operational-classification.js';

export const PRECISION_CLASSIFICATION_VERSION = 'precision-classification-v1.2.2-fix10';
export const EVIDENCE_NORMALIZATION_VERSION = 'exact-source-span-v1';

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

export const CLASSIFICATION_PRECEDENCE = Object.freeze([
  'incomplete-draft',
  'deleted-or-junk-lifecycle',
  'automatic-completion',
  'security-verification-alert',
  'automated-business-document',
  'automatic-reference',
  'incoming-inline-response',
  'informational-update',
  'forwarded-without-current-request',
  'queued-outbound-request',
  'outgoing-delivery',
  'outgoing-request',
  'outgoing-incomplete-message',
  'outgoing-substantive-message',
  'incoming-delivery',
  'base-state',
]);

const NO_ACTION_PATTERN = /(?:별도|추가)?\s*(?:조치|회신|답변|확인).{0,10}(?:필요\s*(?:없|하지)|불필요)|회신\s*(?:불필요|필요\s*없)|참고\s*(?:용|바랍니다|해주세요)|단순\s*공지|뉴스레터|newsletter|unsubscribe|수신거부|\bfyi\b|for your information/i;
const CONCRETE_REQUEST_PATTERN = /(?:부탁(?:드립니다|합니다)?(?![\p{L}\p{N}])|요청(?:드립니다|합니다|드려요|해요|드리며)?(?![\p{L}\p{N}])|해\s*주세요|하여\s*주세요|보내\s*주세요|바랍니다|필요(?:합니다|해요)|please\b|can you|could you|would you|kindly)|(?:검토|확인|승인|작성|수정|제출|발송|보내|공유|전달|회신|답변|준비|협의|일정\s*확정|견적\s*제공).{0,18}(?:부탁(?:드립니다|합니다)?(?![\p{L}\p{N}])|요청(?:드립니다|합니다)?(?![\p{L}\p{N}])|해주세요|보내주세요|바랍니다|필요)/iu;
const ACTION_OBJECT_PATTERN = /견적(?:서)?|제안서|계약(?:서)?|발주(?:서)?|주문서|세금계산서|자료|문서|파일|첨부|정책(?:표)?|보고서|답변|회신|연락처|메일(?:주소)?|이메일|일정(?:표)?|미팅|회의|설치|구축|장비|라이선스|license|quotation|proposal|contract|document|file|reply|send|schedule|contact|email address/i;
const DECISION_PATTERN = /(?:최종\s*)?(?:결정|선택|승인|결재|확정).{0,18}(?:부탁|요청|해\s*주세요|바랍니다|필요)|(?:의견|판단).{0,18}(?:부탁|요청|해\s*주세요|바랍니다)|decision\s+(?:needed|required)|approval\s+(?:needed|required)/i;
const WAITING_PATTERN = /(?:회신|답변|승인|검토|확인|자료|견적|정책|결정).{0,18}(?:대기|기다리)|(?:대기|기다리).{0,18}(?:회신|답변|승인|검토|확인|자료|견적|정책|결정)|waiting\s+for|awaiting|pending\s+(?:approval|review|response|reply|document)/i;
const INTERNAL_ACTOR_PATTERN = /내부|사내|우리\s*팀|담당\s*팀|대표|팀장|엔지니어|기술팀|영업팀|회계팀|법무팀|보안팀|개발팀|internal|our\s+team|engineering\s+team|finance\s+team|legal\s+team/i;
const EXTERNAL_ACTOR_PATTERN = /고객|상대방|제조사|벤더|공급사|파트너|총판|리셀러|발주처|외부|customer|client|vendor|manufacturer|partner|supplier|external/i;
const EXTERNAL_COMMITMENT_PATTERN = /보내\s*드리겠습니다|전달\s*드리겠습니다|회신\s*드리겠습니다|공유\s*드리겠습니다|확인\s*후.{0,12}드리겠습니다|제공\s*하겠습니다|처리\s*하겠습니다|will\s+(?:send|reply|provide|confirm|review)/i;
const COMPLETED_PATTERN = /완료(?:했습니다|되었습니다|됨)|처리(?:했습니다|되었습니다)|발송(?:했습니다|되었습니다)|전달(?:했습니다|되었습니다)|해결(?:했습니다|되었습니다|됨)|종료(?:했습니다|되었습니다|됨)|closed|resolved|completed|done/i;
const CANCELLED_PATTERN = /취소(?:합니다|되었습니다|됐습니다|됨)|철회(?:합니다|되었습니다)|더\s*이상\s*진행하지|중단(?:합니다|되었습니다)|cancelled|canceled|withdrawn/i;
const URGENT_PATTERN = /긴급|즉시|asap|urgent|critical|eod|장애|중단|침해|사고/i;
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
const PROMOTIONAL_CONTENT_PATTERN = /unsubscribe|수신\s*거부|뉴스레터|newsletter|webinar|세미나|프로모션|promotion|광고|마케팅|쿠폰|할인|event\s+invitation|등록\s*(?:하기|하세요)/i;
const FORWARDED_SUBJECT_PATTERN = /^(?:(?:\[(?:fw|fwd)\])\s*)*(?:fw|fwd|전달)\s*:/i;
const THREAD_CONTEXT_SUBJECT_PATTERN = /^(?:(?:\[(?:re|fw|fwd)\])\s*)*(?:re|fw|fwd|전달)\s*:/i;
const ENGLISH_DIRECT_REQUEST_PATTERN = /(?:\b(?:please|can you|could you|would you|kindly)\s+(?:answer|advise|confirm|check|review|investigate|analy[sz]e|support|provide|send|share|update|change|configure|fix|resolve|help|respond|reply)\b|\bis it possible to\b)/i;
const DELIVERY_COMPLETION_PATTERN = /(?:(?:재)?견적(?:서)?|발주서|자료|제안서|라이선스|라이센스|서비스레터|서류|연락처|답변|장비\s*정보).{0,36}(?:전달|송부|첨부|회신|보내)\s*(?:드립니다|드렸습니다|했습니다)|(?:전달|송부|첨부|회신|보내)\s*(?:드립니다|드렸습니다|했습니다)/i;
const AUTOMATED_COMPLETION_PATTERN = /문서(?:가|는)?\s*(?:최종\s*)?완료되었습니다|작업(?:이|은)?\s*완료(?:되었습니다|했습니다)|계약이\s*완료되었습니다/i;
const GREETING_ONLY_PATTERN = /^(?:안녕하세요[,. ]*)?(?:(?:베를로\s*)?박재민(?:입니다|드림)?[,. ]*)?(?:감사합니다[,. ]*)?$/i;
const AUTOMATED_REFERENCE_PATTERN = /(?:email\s*)?verification\s*code|인증\s*(?:번호|코드)|세금계산서(?:를|가)?\s*(?:확인했습니다|수신했습니다|발행되었습니다|전송되었습니다)|전자\s*세금계산서.{0,40}(?:확인했습니다|발행되었습니다)|자동\s*(?:시스템\s*)?알림/i;
const AUTOMATED_INVOICE_NOTICE_PATTERN = /세금계산서(?:가|를)?\s*(?:발행|도착|수신)|발행\s*세금계산서가\s*도착|전자(?:세금)?계산서\s*(?:보기|정보)|세금계산서\s*상태확인요청/i;
const AUTOMATED_DOCUMENT_NOTICE_PATTERN = /수신문서보기|이카운트에서\s*보낸\s*메일|efficient\s*change|(?:loginaa|resourcev3)\.ecount\.com/i;
const TRANSACTION_ACTION_REQUEST_PATTERN = /(?:세금계산서|검수확인서|사업자등록증|발주서|견적서|자료|서류).{0,36}(?:발행|제출|회신|송부|전달|보내|작성).{0,18}(?:부탁|요청|바랍니다|해주세요)|(?:발행|제출|회신|송부|전달|보내|작성).{0,36}(?:세금계산서|검수확인서|사업자등록증|발주서|견적서|자료|서류).{0,18}(?:부탁|요청|바랍니다|해주세요)/i;
const QUEUED_DRAFT_REQUEST_PATTERN = /(?:발주|견적|라이선스|라이센스|자료|서류|회신|답변|확인|제출|발행|검토).{0,160}(?:부탁|요청|바랍니다|해주세요)/i;
const INFORMATIONAL_UPDATE_PATTERN = /(?:내용\s*)?혼선\s*방지.{0,48}(?:수정\s*(?:게시|반영)|업데이트|정리)\s*(?:합니다|했습니다|드립니다)/i;
const INLINE_RESPONSE_UPDATE_PATTERN = /(?:내용\s*)?혼선\s*방지.{0,80}(?:본문|메일).{0,48}(?:수정\s*(?:게시|반영)|업데이트|정리).{0,32}(?:\(\s*아래|아래\s*[,，:]|파란색|붉은색|색상)|(?:아래|파란색|붉은색).{0,48}(?:수정\s*(?:답변|게시|반영)|업데이트)/i;
const CONDITIONAL_FUTURE_OFFER_PATTERN = /(?:추가로\s*)?(?:필요하신|필요한|원하시는).{0,24}(?:자료|내용)?.{0,24}(?:요청|말씀).{0,12}(?:해\s*주시면|주시면).{0,24}(?:전달|보내|공유|회신)\s*(?:드리겠습니다|하겠습니다)|요청해\s*주시면.{0,24}(?:전달|보내|공유|회신)\s*(?:드리겠습니다|하겠습니다)/i;
const NEGATED_ACTION_PATTERN = /(?:전달|회신|확인|제출|발행|검토).{0,16}(?:주실\s*)?필요\s*없|(?:필요\s*없|하지\s*않아도|제외\s*(?:합니다|됩니다|해도))/i;
const OUTGOING_DELIVERY_DONE_PATTERN = /(?:(?:제안서|견적서|발주서|자료|연락처|답변|장비\s*정보|정보).{0,40}(?:정리|전달|송부|첨부|회신|보내)\s*(?:했습니다|드립니다|드렸습니다)|(?:정리|전달|송부|첨부|회신|보내)\s*(?:했습니다|드립니다|드렸습니다).{0,40}(?:제안서|견적서|발주서|자료|연락처|답변|정보))/i;
const GENERIC_REVIEW_REQUEST_PATTERN = /^\s*(?:첨부(?:된)?\s*)?(?:견적(?:서)?|발주서|자료|문서|파일)?\s*(?:확인|검토)\s*(?:부탁드립니다|부탁드리겠습니다|바랍니다|해주세요)[.!]?\s*$/i;
const NON_ACTION_BOILERPLATE_PATTERN = /if you receive this email by mistake|please (?:delete|notify the sender)|수신문서보기|가이드\s*바로가기|(?:버튼|주소|링크).{0,30}클릭|클릭하시어.{0,30}(?:조회|확인|이용)|사용자\s*메뉴얼|조회\s*경로|상태확인요청\s*문서종류|전자계약서.{0,20}접수요청조회|문의사항.{0,30}(?:회신|연락)\s*부탁|궁금하신\s*사항.{0,30}연락\s*부탁/i;
const REPORTED_REQUEST_PATTERN = /(?:요청|부탁)\s*(?:하신|했던|드렸던|받았던|받은|한|된)|요청해\s*주시면/i;
const AUTOMATED_SENDER_PATTERN = /^(?:no[-_.]?reply|noreply|notification|notifications|alert|alerts|mailer-daemon)@/i;
const DUE_CONTEXT_PATTERN = /(?:까지|기한|마감|납기|만료|예정|일정|\d{1,2}월\s*\d{1,2}일\s*(?:날짜로|자로|까지|마감)|가능한\s*빨리|조속히|빠른\s*시일|at\s+your\s+earliest|as\s+soon\s+as\s+possible|due\b|deadline|by\s+\d|before\s+\d)/i;
const BUSINESS_DOCUMENT_REVIEW_PATTERN = /(?:재)?견적(?:서)?|제안서|계약서|발주서|주문서|quotation|proposal|purchase\s*order|contract\s*document/i;
const INFORMATIONAL_DELIVERY_PATTERN = /장비\s*정보|현황표|목록|리스트|엑셀|스프레드시트|일반\s*자료|소개\s*자료|reference\s*material/i;
const OPERATIONAL_COMPLETION_DELIVERY_PATTERN = /(?:작업\s*(?:후|내역)|정상화|조치\s*(?:후|결과)).{0,56}(?:정상|완료|이미지|리포트|결과)|(?:정상|완료).{0,32}(?:작업\s*내역|path\s*이미지|결과\s*첨부)/i;
const SECURITY_VERIFICATION_ALERT_PATTERN = /(?:(?:alert\s*message\s*from|보안\s*알림|appliance).{0,96}(?:verification\s*code|인증\s*(?:번호|코드))|(?:verification\s*code|인증\s*(?:번호|코드)).{0,96}(?:appliance|alert|보안))/is;
const BUSINESS_RECORD_DETAIL_PATTERN = /공급가액|품목|관리번호|문서종류|발신자\s*정보|수신자\s*정보|계약번호|프로젝트\s*:/i;
const GENERIC_ACCOUNT_VERIFICATION_PATTERN = /(?:email\s*)?verification\s*code|인증\s*(?:번호|코드)/i;
const LOW_VALUE_INVOICE_SOURCE_PATTERN = /hometax|홈택스|국세청|srtk\.hometax/i;
const EXPLICIT_THREAD_URGENCY_PATTERN = /\[(?:긴급|urgent|critical)\]|(?:^|[\s:])긴급(?:$|[\s:])/i;
const REMOTE_SUPPORT_ESCALATION_PATTERN = /support\s+remote\s+is\s+best|remote\s+(?:support|session)\s+(?:is\s+)?(?:required|needed|preferred)|원격\s*(?:지원|세션)\s*(?:부탁|요청|필요)/i;
const CONDITIONAL_CONTACT_BOILERPLATE_PATTERN = /(?:should\s+you|if\s+you|when\s+you).{0,80}(?:inquir|question|issue|need|require|encounter).{0,80}(?:please\s+)?(?:reply|contact|reach\s+out)|(?:추가|기타).{0,36}(?:문의|필요(?:한|하신)?\s*사항).{0,48}(?:있으|생기).{0,36}(?:회신|연락|문의).{0,24}(?:부탁|바랍니다|주세요)|(?:문의사항|문의\s*사항).{0,36}(?:고객센터|콜센터|해당\s*쇼핑몰).{0,24}(?:연락|이용)|(?:추가\s*문의|관련\s*문의).{0,36}(?:연락|회신).{0,20}(?:바랍니다|주세요)/is;
const LOW_VALUE_AUTOMATED_REFERENCE_PATTERN = /(?:법인)?카드.{0,32}이용대금\s*명세서|이용대금\s*명세서|보험증권\s*송부|청약서\s*송부|회원가입(?:을)?\s*축하|임시\s*비밀번호\s*안내|발행현황보고서|세금계산서를\s*확인했습니다|심사\s*완료\s*안내|실물\s*카드\s*제작|reply\s+from\s+.+\([^)]+\)|teamwork\s+collection|try\s+free\s+for|elevate\s+.+\s+workflows/i;
const TAX_INVOICE_REVIEW_PATTERN = /전자세금계산서\s*발급\s*메일\s*안내|사업자가.{0,100}전자세금계산서를\s*발급하고\s*발송|전자세금계산서가.{0,40}(?:발급|발행)되었/i;
const INVOICE_READY_REVIEW_PATTERN = /청구서.{0,40}(?:준비되었습니다|검토할\s*준비가\s*되었습니다)|invoice.{0,40}(?:is\s+ready|ready\s+for\s+review|available\s+for\s+review)/i;
const SUBSCRIPTION_RENEWAL_COMPLETED_PATTERN = /구독(?:이|을)?\s*(?:성공적으로\s*)?갱신(?:되었습니다|했습니다)|subscription.{0,40}(?:successfully\s*)?renewed/i;
const SERVICE_DEACTIVATION_ACTION_PATTERN = /subscription.{0,64}(?:deactivated|deactivation|suspended|disabled).{0,48}(?:inactivity|soon)|(?:구독|계정|서비스).{0,40}(?:비활성화|중지|해지).{0,32}(?:예정|됩니다|임박)/i;
const SUPPORT_TICKET_CONTEXT_PATTERN = /\[?ticket\s*#|case\s+ticket|support\s+staff|기술\s*지원\s*(?:티켓|케이스)/i;
const SUPPORT_COMPLETION_PATTERN = /issue\s+has\s+been\s+resolved|proceed\s+to\s+close\s+this\s+ticket|ticket\s+(?:will\s+be|is\s+being|has\s+been)\s+closed|(?:문제|이슈).{0,24}해결.{0,40}(?:티켓|케이스).{0,24}(?:종료|닫)|(?:티켓|케이스).{0,32}(?:종료|닫).{0,24}(?:진행|예정)/i;
const SUPPORT_SCHEDULE_CONFIRMATION_PATTERN = /(?:let'?s\s+make\s+it|we\s+can\s+make\s+it|scheduled\s+for|confirmed\s+for).{0,64}(?:tomorrow|today|\d{1,2}(?::\d{2})?\s*(?:am|pm)|gmt[+-]?\d*|오전|오후)|(?:tomorrow|today).{0,40}(?:works|confirmed|scheduled)/i;
const SUPPORT_INFORMATIONAL_PATTERN = /no\s+public\s+(?:website|download).{0,48}available|there\s+is\s+no\s+.{0,48}available|should\s+you\s+encounter\s+this\s+issue\s+again|we\s+will\s+assist\s+in\s+providing/i;
const DIRECT_INQUIRY_PATTERN = /문의\s*(?:드립니다|드리며|드리오며|드려요)|여쭙고자|가능한지\s*(?:문의|확인)?|가능\s*여부.{0,20}(?:확인|답변)|확인\s*요청드리오며|(?:값|번호|내용|정보|형태).{0,24}입력\s*부탁|(?:업체|계정|사용자).{0,24}등록\s*요청|(?:please|kindly)\s+(?:provide|confirm|advise)\b/i;
const OUTGOING_RESPONSE_COMPLETED_PATTERN = /(?:아래와\s*같이|다음과\s*같이).{0,36}(?:답변|회신)\s*(?:드립니다|드렸습니다|했습니다)|(?:문의|요청|확인\s*요청).{0,32}(?:사항|내용).{0,32}(?:답변|회신)\s*(?:드립니다|드렸습니다|했습니다)|(?:답변|회신)\s*(?:드립니다|드렸습니다|했습니다)/i;
const CARD_CONTRACT_REVIEW_PATTERN = /(?:법인\s*회원|법인\s*카드|카드).{0,28}(?:계약서류|계약\s*서류)\s*안내|card.{0,32}contract\s+documents?/i;
const DECISION_PROCESS_CONTEXT_PATTERN = /승인\s*(?:처리|진행|절차|완료).{0,32}(?:위해|후).{0,40}(?:회신|등록|제출)|(?:업체|계정|사용자)\s*등록.{0,48}승인\s*(?:처리|진행)/i;

const SIGNATURE_MARKERS = [
  /^-{10,}\s*$/,
  /^--\s*$/,
  /^감사합니다[.!]?$/,
  /^고맙습니다[.!]?$/,
  /^best regards[,]?$/i,
  /^kind regards[,]?$/i,
  /^regards[,]?$/i,
  /^sent from my /i,
  /^(?:ios|android)용\s*outlook/i,
  /^if you receive this email by mistake/i,
  /^this (?:e-mail|email).{0,80}confidential/i,
  /^본 메일은.{0,80}(?:기밀|수신인)/i,
];

const HARD_HISTORY_MARKERS = [
  /^-{2,}\s*(?:original message|원본 메시지|forwarded message|전달된 메시지 시작|보낸 메시지 시작)\s*-{2,}$/i,
  /^begin forwarded message:\s*$/i,
  /^forwarded by\b/i,
  /^_{5,}$/,
  /^on\s.+wrote:\s*$/i,
  /^(?:20\d{2}년.{0,140})?[^\n:]{1,160}님이\s*작성\s*:\s*$/i,
  /^>+\s*/,
];

const HISTORY_HEADER_PATTERNS = [
  /^(?:보낸 사람|발신|from)\s*:/i,
  /^(?:보낸 날짜|보낸 시각|sent|date)\s*:/i,
  /^(?:받는 사람|수신|to)\s*:/i,
  /^(?:참조|cc)\s*:/i,
  /^(?:제목|subject)\s*:/i,
];

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value = '') {
  return normalizeSpace(value).toLowerCase();
}

function meaningfulText(value = '') {
  return String(value || '')
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\[(?:https?:\/\/|cid:)[^\]]+\]/gi, ' ')
    .replace(/\[[^\]]*\.(?:png|jpe?g|gif|svg)[^\]]*\]/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function attachmentOnlyReference(message, currentText) {
  const subject = normalizeSpace(message.subject || '');
  const filenameSubject = /\.(?:pdf|docx?|xlsx?|pptx?|ai|zip|png|jpe?g|gif)$/i.test(subject);
  return Boolean(message.hasAttachments)
    && filenameSubject
    && meaningfulText(currentText).length < 16;
}

function isInvoiceFolder(message = {}) {
  return /세금계산서|tax\s*invoice|invoice/i.test(
    `${message.folderWellKnownName || ''}\n${message.folderName || ''}`,
  );
}

function messageAgeDays(message = {}, nowValue = new Date()) {
  const occurredAt = new Date(message.receivedAt || message.sentAt || '');
  const now = new Date(nowValue);
  if (Number.isNaN(occurredAt.getTime()) || Number.isNaN(now.getTime())) return null;
  return (now.getTime() - occurredAt.getTime()) / (24 * 60 * 60 * 1000);
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

function headerClusterAt(lines, index) {
  if (!HISTORY_HEADER_PATTERNS[0].test(lines[index]?.trim() || '')) return false;
  const window = lines.slice(index, Math.min(lines.length, index + 7));
  const matchedKinds = new Set();
  for (const line of window) {
    const trimmed = line.trim();
    HISTORY_HEADER_PATTERNS.forEach((pattern, kind) => {
      if (pattern.test(trimmed)) matchedKinds.add(kind);
    });
  }
  return matchedKinds.has(0) && matchedKinds.size >= 3;
}

export function splitMessageHistory(value = '') {
  const normalized = String(value || '').replace(/\r/g, '');
  const lines = normalized.split('\n');
  let boundary = lines.length;
  let boundaryType = 'none';
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (HARD_HISTORY_MARKERS.some((pattern) => pattern.test(trimmed))) {
      boundary = index;
      boundaryType = 'explicit-history-marker';
      break;
    }
    if (headerClusterAt(lines, index)) {
      boundary = index;
      boundaryType = 'message-header-cluster';
      break;
    }
  }
  let currentEnd = boundary;
  const currentLines = lines.slice(0, boundary);
  for (let index = Math.max(0, currentLines.length - 16); index < currentLines.length; index += 1) {
    const trimmed = currentLines[index].trim();
    if (SIGNATURE_MARKERS.some((pattern) => pattern.test(trimmed))) {
      currentEnd = index;
      break;
    }
  }
  const currentContent = lines.slice(0, currentEnd).join('\n').trim();
  const quotedContent = boundary < lines.length ? lines.slice(boundary).join('\n').trim() : '';
  return { currentContent, quotedContent, boundaryType, boundaryLine: boundary < lines.length ? boundary + 1 : null };
}

export function stripQuotedHistory(value = '') {
  return splitMessageHistory(value).currentContent;
}

function clausesWithOffsets(value = '', sourceField = 'body', sourceMessageId = '') {
  const sourceText = String(value || '');
  const clauses = [];
  const pattern = /[^.!?。！？\n]+[.!?。！？]?/gu;
  let match;
  while ((match = pattern.exec(sourceText))) {
    const raw = match[0];
    const leading = raw.search(/\S/);
    if (leading < 0) continue;
    const trailing = raw.match(/\s*$/u)?.[0]?.length || 0;
    const startOffset = match.index + leading;
    const endOffset = match.index + raw.length - trailing;
    if (endOffset <= startOffset) continue;
    const exactText = sourceText.slice(startOffset, endOffset);
    if (exactText.length < 3) continue;
    clauses.push({
      text: exactText,
      exactText,
      start: startOffset,
      end: endOffset,
      startOffset,
      endOffset,
      sourceField,
      sourceMessageId: String(sourceMessageId || ''),
      sourceText,
    });
  }
  return clauses;
}

function evidence(clause, field, rule) {
  if (!clause) return null;
  const sourceText = String(clause.sourceText || '');
  const startOffset = Number(clause.startOffset ?? clause.start ?? 0);
  const endOffset = Number(clause.endOffset ?? clause.end ?? 0);
  const exactText = sourceText.slice(startOffset, endOffset);
  if (!exactText || exactText !== clause.exactText || exactText !== clause.text) return null;
  return {
    field,
    sourceField: clause.sourceField || 'body',
    sourceMessageId: String(clause.sourceMessageId || ''),
    startOffset,
    endOffset,
    exactText,
    text: exactText,
    sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    normalizationVersion: EVIDENCE_NORMALIZATION_VERSION,
    start: startOffset,
    end: endOffset,
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
  if (NON_ACTION_BOILERPLATE_PATTERN.test(value) || isPriorityBoilerplate(value)) return false;
  if (CONDITIONAL_CONTACT_BOILERPLATE_PATTERN.test(value)) return false;
  if (REPORTED_REQUEST_PATTERN.test(value)
      && !/(?:부탁드립니다|요청드립니다|해\s*주세요|해주세요|바랍니다|please\b|can you|could you|would you)/i.test(value)) return false;
  if (DIRECT_INQUIRY_PATTERN.test(value)) return true;
  if (ENGLISH_DIRECT_REQUEST_PATTERN.test(value)) return true;
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
  if (/(?:협의|회신|답변|연락).{0,18}(?:부탁(?:드립니다|드리겠습니다)?|바랍니다|해주세요)/i.test(value)) return true;
  if (ACTION_OBJECT_PATTERN.test(value)) return true;
  return /(?:오늘|내일|금일|이번\s*주|다음\s*주|\d{1,2}시|\d{4}[.-]\d{1,2}[.-]\d{1,2})/.test(value);
}

function hasVerifiedDirectRequest(text) {
  const value = String(text || '');
  if (CONDITIONAL_FUTURE_OFFER_PATTERN.test(value)) return false;
  if (NEGATED_ACTION_PATTERN.test(value)) return false;
  if (/참고\s*(?:부탁드립니다|부탁드리겠습니다|바랍니다|해주세요)/i.test(value)) return false;
  return hasConcreteRequest(value);
}

function verifiedActionClauses(clauses = []) {
  const seen = new Set();
  const verified = [];
  for (const clause of clauses) {
    if (clause.sourceField !== 'body' || !hasVerifiedDirectRequest(clause.text)) continue;
    const actionSignature = normalizeComparable(clause.text)
      .replace(/\d+/g, '#')
      .replace(/[^\p{L}\p{N}#]+/gu, ' ')
      .trim();
    if (!actionSignature || seen.has(actionSignature)) continue;
    seen.add(actionSignature);
    verified.push(clause);
  }
  return verified;
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

function focusedClauses(clauses, stateEvidence) {
  const selected = [];
  const seen = new Set();
  const add = (clause) => {
    if (!clause) return;
    const key = `${clause.sourceField}:${clause.startOffset}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(clause);
  };
  clauses.filter((clause) => clause.sourceField === 'subject').forEach(add);
  clauses.filter((clause) => clause.sourceField === 'body').slice(0, 4).forEach(add);
  add(stateEvidence);
  return selected;
}

function dueInputText(clauses, stateEvidence) {
  const selected = [];
  const seen = new Set();
  const add = (clause) => {
    if (!clause) return;
    const key = `${clause.sourceField}:${clause.startOffset}`;
    if (seen.has(key)) return;
    seen.add(key);
    selected.push(clause.text);
  };
  add(stateEvidence);
  clauses.filter((clause) => DUE_CONTEXT_PATTERN.test(clause.text)).forEach(add);
  if (stateEvidence && DUE_CONTEXT_PATTERN.test(stateEvidence.text)) {
    clauses
      .filter((clause) => clause.sourceField === stateEvidence.sourceField
        && Math.abs(clause.startOffset - stateEvidence.startOffset) <= 320)
      .forEach(add);
  }
  return selected.join('\n');
}

function supportingSignals(message, currentText, clauses, stateEvidence, due) {
  const signals = [];
  const focusedText = focusedClauses(clauses, stateEvidence).map((clause) => clause.text).join('\n');
  if (due.duePrecision !== 'none') signals.push('deadline');
  if (AMOUNT_PATTERN.test(currentText)) signals.push('amount');
  if (QUOTATION_CONTRACT_PATTERN.test(currentText)) signals.push('quotation_contract');
  if (message.hasAttachments || ATTACHMENT_MENTION_PATTERN.test(currentText)) signals.push('attachment');
  if (!message.hasAttachments && ATTACHMENT_PROMISE_PATTERN.test(currentText)) signals.push('attachment_missing');
  if (SCHEDULE_PATTERN.test(focusedText)) signals.push('schedule');
  if (APPROVAL_PATTERN.test(focusedText)) signals.push('approval');
  if (INCIDENT_SECURITY_PATTERN.test(focusedText)) signals.push('incident_security');
  return SUPPORTING_SIGNALS.filter((signal) => signals.includes(signal));
}

function stateAndEvidence(clauses, currentText) {
  const requestClauses = clauses.filter((clause) => hasConcreteRequest(clause.text));
  const decisionClauses = matching(clauses, DECISION_PATTERN);
  const waitingClauses = matching(clauses, WAITING_PATTERN);
  const completedClauses = matching(clauses, COMPLETED_PATTERN);
  const cancelledClauses = matching(clauses, CANCELLED_PATTERN);
  const noActionClauses = matching(clauses, NO_ACTION_PATTERN);
  const concreteDecision = decisionClauses.find((clause) => hasConcreteRequest(clause.text)
    && !DECISION_PROCESS_CONTEXT_PATTERN.test(clause.text)) || null;
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

  const commitment = clauses.find((clause) => EXTERNAL_COMMITMENT_PATTERN.test(clause.text)
    && !CONDITIONAL_FUTURE_OFFER_PATTERN.test(clause.text)) || null;
  if (commitment) {
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

function adjustedStateForMessage(message, state, clauses, currentText, nowValue = new Date()) {
  const outgoing = Boolean(message.isOutgoing);
  const lifecycleEvidence = state.stateEvidence || clauses[0] || null;
  const bodyCurrentText = normalizeSpace(
    clauses
      .filter((clause) => clause.sourceField === 'body')
      .map((clause) => clause.text)
      .join(' '),
  );
  const subjectCurrentText = normalizeSpace(String(message.subject || ''));
  const meaningfulSubject = subjectCurrentText
    .replace(THREAD_CONTEXT_SUBJECT_PATTERN, '')
    .replace(/^[\s[\](){}:;,_-]+|[\s[\](){}:;,_-]+$/g, '')
    .trim();
  const emptyOrGreetingOnly = !bodyCurrentText || GREETING_ONLY_PATTERN.test(bodyCurrentText);
  if (message.isDeletedFolder || message.isJunkFolder) {
    if (message.isDraft || message.isDraftFolder) {
      const ageDays = messageAgeDays(message, nowValue);
      const recentDraft = ageDays == null || ageDays <= 7;
      if (emptyOrGreetingOnly && meaningfulSubject.length < 4) {
        if (!recentDraft) {
          return {
            workState: 'reference',
            stateConfidence: 0.9,
            stateEvidence: clauses.find((clause) => clause.sourceField === 'body') || lifecycleEvidence,
            stateRule: 'aged-deleted-draft-reference',
            reviewReasons: [],
          };
        }
        return {
          workState: 'review_required',
          stateConfidence: 0.7,
          stateEvidence: clauses.find((clause) => clause.sourceField === 'body') || lifecycleEvidence,
          stateRule: bodyCurrentText ? 'deleted-greeting-draft-review' : 'deleted-empty-draft-review',
          reviewReasons: ['incomplete_draft'],
        };
      }
      if (meaningfulSubject.length >= 4) {
        return {
          workState: 'reference',
          stateConfidence: 0.88,
          stateEvidence: clauses.find((clause) => clause.sourceField === 'subject') || lifecycleEvidence,
          stateRule: 'abandoned-draft-reference',
          reviewReasons: [],
        };
      }
    }
    return {
      workState: 'reference',
      stateConfidence: 0.98,
      stateEvidence: lifecycleEvidence,
      stateRule: message.isJunkFolder ? 'junk-folder-reference' : 'deleted-folder-reference',
      reviewReasons: [],
    };
  }

  if ((message.isDraft || message.isDraftFolder) && emptyOrGreetingOnly) {
    return {
      workState: 'review_required',
      stateConfidence: 0.72,
      stateEvidence: clauses.find((clause) => clause.sourceField === 'body') || lifecycleEvidence,
      stateRule: bodyCurrentText ? 'greeting-only-draft-review' : 'empty-draft-review',
      reviewReasons: ['incomplete_draft'],
    };
  }

  const concreteRequest = clauses.find((clause) => hasConcreteRequest(clause.text)) || null;
  const directRequest = clauses.find((clause) => hasVerifiedDirectRequest(clause.text)) || null;
  const transactionRequest = clauses.find((clause) => TRANSACTION_ACTION_REQUEST_PATTERN.test(clause.text)) || null;
  const delivery = firstMatching(clauses, DELIVERY_COMPLETION_PATTERN)
    || firstMatching(clauses, OUTGOING_DELIVERY_DONE_PATTERN);
  const genericReview = firstMatching(clauses, GENERIC_REVIEW_REQUEST_PATTERN);
  const queuedOutboundDraft = Boolean(message.isDraft || message.isDraftFolder);
  const queuedDraftRequest = directRequest
    || transactionRequest
    || genericReview
    || concreteRequest
    || (queuedOutboundDraft ? firstMatching(clauses, QUEUED_DRAFT_REQUEST_PATTERN) : null);
  const combinedText = `${message.subject || ''}\n${currentText}`;
  const supportContext = SUPPORT_TICKET_CONTEXT_PATTERN.test(combinedText);

  const serviceDeactivation = firstMatching(clauses, SERVICE_DEACTIVATION_ACTION_PATTERN);
  if (!outgoing
      && serviceDeactivation
      && !message.isPromotional
      && !PROMOTIONAL_CONTENT_PATTERN.test(combinedText)) {
    return {
      workState: 'action_required',
      stateConfidence: 0.94,
      stateEvidence: serviceDeactivation,
      stateRule: 'service-deactivation-action',
      reviewReasons: [],
    };
  }

  const supportCompletion = supportContext
    ? firstMatching(clauses, SUPPORT_COMPLETION_PATTERN)
      || (SUPPORT_COMPLETION_PATTERN.test(combinedText) ? lifecycleEvidence : null)
    : null;
  if (!outgoing && supportCompletion) {
    return {
      workState: 'completed',
      stateConfidence: 0.97,
      stateEvidence: supportCompletion,
      stateRule: 'support-ticket-completed',
      reviewReasons: [],
    };
  }

  const supportSchedule = supportContext
    ? firstMatching(clauses, SUPPORT_SCHEDULE_CONFIRMATION_PATTERN)
    : null;
  if (!outgoing && supportSchedule) {
    return {
      workState: 'waiting',
      stateConfidence: 0.91,
      stateEvidence: supportSchedule,
      stateRule: 'support-schedule-confirmed',
      reviewReasons: [],
    };
  }

  const subscriptionRenewal = firstMatching(clauses, SUBSCRIPTION_RENEWAL_COMPLETED_PATTERN)
    || (SUBSCRIPTION_RENEWAL_COMPLETED_PATTERN.test(combinedText) ? lifecycleEvidence : null);
  if (!outgoing && subscriptionRenewal) {
    return {
      workState: 'completed',
      stateConfidence: 0.96,
      stateEvidence: subscriptionRenewal,
      stateRule: 'subscription-renewal-completed',
      reviewReasons: [],
    };
  }

  const taxInvoiceReview = firstMatching(clauses, TAX_INVOICE_REVIEW_PATTERN)
    || (TAX_INVOICE_REVIEW_PATTERN.test(combinedText) ? lifecycleEvidence : null);
  if (!outgoing && taxInvoiceReview && isInvoiceFolder(message)) {
    return {
      workState: 'review_required',
      stateConfidence: 0.89,
      stateEvidence: taxInvoiceReview,
      stateRule: 'received-tax-invoice-review',
      reviewReasons: ['business_document_requires_review'],
    };
  }

  const invoiceReady = firstMatching(clauses, INVOICE_READY_REVIEW_PATTERN)
    || (INVOICE_READY_REVIEW_PATTERN.test(combinedText) ? lifecycleEvidence : null);
  if (!outgoing && invoiceReady) {
    return {
      workState: 'review_required',
      stateConfidence: 0.88,
      stateEvidence: invoiceReady,
      stateRule: 'invoice-ready-review',
      reviewReasons: ['business_document_requires_review'],
    };
  }

  const cardContractReview = firstMatching(clauses, CARD_CONTRACT_REVIEW_PATTERN)
    || (CARD_CONTRACT_REVIEW_PATTERN.test(combinedText) ? lifecycleEvidence : null);
  if (!outgoing && cardContractReview) {
    return {
      workState: 'review_required',
      stateConfidence: 0.86,
      stateEvidence: cardContractReview,
      stateRule: 'card-contract-document-review',
      reviewReasons: ['business_document_requires_review'],
    };
  }

  if (!outgoing && attachmentOnlyReference(message, currentText)) {
    return {
      workState: 'reference',
      stateConfidence: 0.92,
      stateEvidence: clauses.find((clause) => clause.sourceField === 'subject') || lifecycleEvidence,
      stateRule: 'attachment-only-reference',
      reviewReasons: [],
    };
  }

  const lowValueAutomatedReference = firstMatching(clauses, LOW_VALUE_AUTOMATED_REFERENCE_PATTERN)
    || (LOW_VALUE_AUTOMATED_REFERENCE_PATTERN.test(combinedText) ? lifecycleEvidence : null);
  if (!outgoing && lowValueAutomatedReference) {
    return {
      workState: 'reference',
      stateConfidence: 0.97,
      stateEvidence: lowValueAutomatedReference,
      stateRule: 'low-value-automated-reference',
      reviewReasons: [],
    };
  }

  const automaticCompletion = firstMatching(clauses, AUTOMATED_COMPLETION_PATTERN);
  if (automaticCompletion
      && !transactionRequest
      && !['action_required', 'decision_required'].includes(state.workState)) {
    return {
      workState: 'completed',
      stateConfidence: 0.98,
      stateEvidence: automaticCompletion,
      stateRule: 'automatic-completion',
      reviewReasons: [],
    };
  }
  const securityVerificationAlert = firstMatching(clauses, SECURITY_VERIFICATION_ALERT_PATTERN)
    || (SECURITY_VERIFICATION_ALERT_PATTERN.test(`${message.subject || ''}\n${currentText}`)
      ? lifecycleEvidence
      : null);
  if (securityVerificationAlert && !transactionRequest) {
    return {
      workState: 'review_required',
      stateConfidence: 0.9,
      stateEvidence: securityVerificationAlert,
      stateRule: 'security-verification-alert-review',
      reviewReasons: ['security_verification_alert'],
    };
  }
  const automatedBusinessDocument = AUTOMATED_DOCUMENT_NOTICE_PATTERN.test(currentText)
    && BUSINESS_DOCUMENT_REVIEW_PATTERN.test(`${message.subject || ''}\n${currentText}`);
  if (automatedBusinessDocument && !transactionRequest) {
    return {
      workState: 'review_required',
      stateConfidence: 0.88,
      stateEvidence: firstMatching(clauses, BUSINESS_DOCUMENT_REVIEW_PATTERN)
        || firstMatching(clauses, AUTOMATED_DOCUMENT_NOTICE_PATTERN)
        || lifecycleEvidence,
      stateRule: 'automated-business-document-review',
      reviewReasons: ['business_document_requires_review'],
    };
  }
  const strongAutomaticNotice = AUTOMATED_REFERENCE_PATTERN.test(currentText)
    || AUTOMATED_INVOICE_NOTICE_PATTERN.test(currentText)
    || AUTOMATED_DOCUMENT_NOTICE_PATTERN.test(currentText)
    || AUTOMATED_SENDER_PATTERN.test(String(message.from || message.senderEmail || ''));
  if (strongAutomaticNotice && !transactionRequest) {
    return {
      workState: 'reference',
      stateConfidence: 0.98,
      stateEvidence: firstMatching(clauses, AUTOMATED_REFERENCE_PATTERN)
        || firstMatching(clauses, AUTOMATED_INVOICE_NOTICE_PATTERN)
        || firstMatching(clauses, AUTOMATED_DOCUMENT_NOTICE_PATTERN)
        || lifecycleEvidence,
      stateRule: 'automatic-notification-reference',
      reviewReasons: [],
    };
  }

  const supportInformational = supportContext
    && SUPPORT_INFORMATIONAL_PATTERN.test(currentText)
    && !directRequest;
  if (!outgoing && supportInformational) {
    return {
      workState: 'reference',
      stateConfidence: 0.9,
      stateEvidence: firstMatching(clauses, SUPPORT_INFORMATIONAL_PATTERN) || lifecycleEvidence,
      stateRule: 'support-informational-reference',
      reviewReasons: [],
    };
  }

  if (!outgoing && directRequest && DIRECT_INQUIRY_PATTERN.test(directRequest.text)) {
    return {
      workState: 'action_required',
      stateConfidence: 0.94,
      stateEvidence: directRequest,
      stateRule: 'incoming-direct-inquiry',
      reviewReasons: [],
    };
  }

  if (!outgoing
      && INLINE_RESPONSE_UPDATE_PATTERN.test(currentText)) {
    return {
      workState: 'action_required',
      stateConfidence: 0.9,
      stateEvidence: firstMatching(clauses, INLINE_RESPONSE_UPDATE_PATTERN) || lifecycleEvidence,
      stateRule: 'incoming-inline-response-update',
      reviewReasons: [],
    };
  }

  if (!outgoing
      && state.workState === 'review_required'
      && INFORMATIONAL_UPDATE_PATTERN.test(currentText)) {
    return {
      workState: 'reference',
      stateConfidence: 0.88,
      stateEvidence: firstMatching(clauses, INFORMATIONAL_UPDATE_PATTERN) || lifecycleEvidence,
      stateRule: 'informational-update-reference',
      reviewReasons: [],
    };
  }

  if (FORWARDED_SUBJECT_PATTERN.test(String(message.subject || '').trim())
      && !normalizeSpace(currentText)
      && state.workState === 'review_required') {
    return {
      workState: 'reference',
      stateConfidence: 0.9,
      stateEvidence: lifecycleEvidence,
      stateRule: 'forwarded-without-current-request',
      reviewReasons: [],
    };
  }

  if (queuedOutboundDraft
      && queuedDraftRequest
      && !GREETING_ONLY_PATTERN.test(normalizeSpace(currentText))) {
    return {
      ...state,
      workState: 'waiting',
      stateConfidence: 0.9,
      stateEvidence: queuedDraftRequest,
      stateRule: 'queued-outbound-request',
      reviewReasons: [],
    };
  }

  if (outgoing && delivery && !directRequest && !genericReview) {
    return {
      workState: 'completed',
      stateConfidence: 0.92,
      stateEvidence: delivery,
      stateRule: 'outgoing-delivery-completed',
      reviewReasons: [],
    };
  }

  const outgoingResponse = outgoing
    ? firstMatching(clauses, OUTGOING_RESPONSE_COMPLETED_PATTERN)
    : null;
  if (outgoing && outgoingResponse && !directRequest) {
    return {
      workState: 'completed',
      stateConfidence: 0.92,
      stateEvidence: outgoingResponse,
      stateRule: 'outgoing-response-completed',
      reviewReasons: [],
    };
  }

  if (outgoing && ['action_required', 'decision_required'].includes(state.workState)) {
    return {
      ...state,
      workState: 'waiting',
      stateConfidence: 0.96,
      stateRule: 'outgoing-request-awaiting-recipient',
      reviewReasons: [],
    };
  }

  if (outgoing && state.workState === 'review_required' && GREETING_ONLY_PATTERN.test(normalizeSpace(currentText))) {
    return {
      workState: 'review_required',
      stateConfidence: 0.72,
      stateEvidence: clauses.find((clause) => clause.sourceField === 'body') || lifecycleEvidence,
      stateRule: 'outgoing-incomplete-message-review',
      reviewReasons: ['incomplete_outgoing_message'],
    };
  }
  if (outgoing
      && state.workState === 'review_required'
      && (delivery || ACTION_OBJECT_PATTERN.test(currentText) || AMOUNT_PATTERN.test(currentText) || SCHEDULE_PATTERN.test(currentText))
      && normalizeSpace(currentText).length >= 12
      && !NON_ACTION_BOILERPLATE_PATTERN.test(currentText)
      && !CONDITIONAL_CONTACT_BOILERPLATE_PATTERN.test(currentText)) {
    return {
      workState: 'waiting',
      stateConfidence: 0.82,
      stateEvidence: concreteRequest || delivery || clauses.find((clause) => clause.sourceField === 'body') || lifecycleEvidence,
      stateRule: 'outgoing-message-awaiting-recipient',
      reviewReasons: [],
    };
  }
  if (!outgoing && state.workState === 'review_required' && delivery) {
    if (genericReview) {
      return {
        workState: 'action_required',
        stateConfidence: 0.91,
        stateEvidence: genericReview,
        stateRule: 'incoming-delivery-review-request',
        reviewReasons: [],
      };
    }
    if (OPERATIONAL_COMPLETION_DELIVERY_PATTERN.test(currentText)) {
      return {
        workState: 'completed',
        stateConfidence: 0.94,
        stateEvidence: firstMatching(clauses, OPERATIONAL_COMPLETION_DELIVERY_PATTERN) || delivery,
        stateRule: 'incoming-operational-completion',
        reviewReasons: [],
      };
    }
    if (BUSINESS_DOCUMENT_REVIEW_PATTERN.test(`${message.subject || ''}\n${currentText}`)) {
      return {
        workState: 'review_required',
        stateConfidence: 0.78,
        stateEvidence: delivery,
        stateRule: 'incoming-business-document-review',
        reviewReasons: ['business_document_requires_review'],
      };
    }
    if (INFORMATIONAL_DELIVERY_PATTERN.test(`${message.subject || ''}\n${currentText}`)) {
      return {
        workState: 'reference',
        stateConfidence: 0.9,
        stateEvidence: delivery,
        stateRule: 'incoming-informational-delivery-reference',
        reviewReasons: [],
      };
    }
    return {
      workState: 'reference',
      stateConfidence: 0.78,
      stateEvidence: delivery,
      stateRule: 'incoming-delivery-reference',
      reviewReasons: [],
    };
  }
  return state;
}

function actorAndEvidence(message, currentText, clauses, workState, stateEvidence, mailboxAddress = '', mailboxAddresses = []) {
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
  const ownAddresses = new Set([mailboxAddress, ...(mailboxAddresses || [])].map(normalizeComparable).filter(Boolean));
  const outgoing = !message.isDraftFolder && !message.isDraft
    && (Boolean(message.isOutgoing) || ownAddresses.has(sender));
  const queuedOutboundDraft = Boolean(message.isDraft || message.isDraftFolder)
    && clauses.some((clause) => hasVerifiedDirectRequest(clause.text)
      || QUEUED_DRAFT_REQUEST_PATTERN.test(clause.text));
  const owner = firstMatching(clauses, OWNER_PATTERN);
  if (owner) {
    const ownerName = owner.text.match(OWNER_PATTERN)?.[1] || '';
    if (INTERNAL_ACTOR_PATTERN.test(ownerName) || normalizeComparable(ownerName) !== normalizeComparable(message.fromName || '')) {
      return { nextActor: 'internal_team', actorConfidence: 0.82, actorEvidence: owner, actorRule: 'explicit-owner' };
    }
  }

  const actorClauses = stateEvidence ? [stateEvidence] : clauses;
  const internal = firstMatching(actorClauses, INTERNAL_ACTOR_PATTERN);
  const external = firstMatching(actorClauses, EXTERNAL_ACTOR_PATTERN);

  if (workState === 'waiting') {
    if (queuedOutboundDraft) {
      return { nextActor: 'external_party', actorConfidence: 0.9, actorEvidence: stateEvidence, actorRule: 'queued-outbound-recipient' };
    }
    if (stateEvidence && SUPPORT_SCHEDULE_CONFIRMATION_PATTERN.test(stateEvidence.text)) {
      return { nextActor: 'external_party', actorConfidence: 0.91, actorEvidence: stateEvidence, actorRule: 'support-schedule-provider' };
    }
    if (outgoing) {
      return { nextActor: 'external_party', actorConfidence: 0.96, actorEvidence: stateEvidence, actorRule: 'outgoing-awaiting-recipient' };
    }
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

function priorityAndEvidence(message, currentText, clauses, workState, stateEvidence, due, signals, nowValue = new Date()) {
  if (workState === 'completed') {
    const automatedCompletion = AUTOMATED_COMPLETION_PATTERN.test(currentText)
      && (AUTOMATED_SENDER_PATTERN.test(String(message.from || message.senderEmail || ''))
        || /eformsign|완료\s*문서\s*보기|powered\s+by\s+eformsign/i.test(currentText));
    const operationalCompletion = OPERATIONAL_COMPLETION_DELIVERY_PATTERN.test(currentText);
    if (automatedCompletion || operationalCompletion) {
      return {
        priority: 'low',
        priorityConfidence: 0.98,
        priorityEvidence: stateEvidence || clauses[0] || null,
        priorityRule: automatedCompletion ? 'automated-completion-low' : 'operational-completion-low',
      };
    }
    const subjectUrgency = firstMatching(
      clausesWithOffsets(String(message.subject || ''), 'subject', String(message.id || '')),
      EXPLICIT_THREAD_URGENCY_PATTERN,
    );
    if (subjectUrgency) {
      return {
        priority: 'high',
        priorityConfidence: 0.9,
        priorityEvidence: subjectUrgency,
        priorityRule: 'completed-explicit-thread-urgency',
      };
    }
    return { priority: 'normal', priorityConfidence: 0.9, priorityEvidence: stateEvidence || clauses[0] || null, priorityRule: 'completed-business-context' };
  }
  if (workState === 'reference') {
    const bodyCurrentText = normalizeSpace(
      clauses
        .filter((clause) => clause.sourceField === 'body')
        .map((clause) => clause.text)
        .join(' '),
    );
    const businessRecordDetails = BUSINESS_RECORD_DETAIL_PATTERN.test(currentText);
    const genericVerification = GENERIC_ACCOUNT_VERIFICATION_PATTERN.test(currentText)
      && !SECURITY_VERIFICATION_ALERT_PATTERN.test(`${message.subject || ''}\n${currentText}`);
    const lowInvoiceNotice = AUTOMATED_INVOICE_NOTICE_PATTERN.test(currentText)
      && (!businessRecordDetails || LOW_VALUE_INVOICE_SOURCE_PATTERN.test(`${message.from || ''}\n${message.subject || ''}`));
    const lowAutomaticDocument = AUTOMATED_DOCUMENT_NOTICE_PATTERN.test(currentText)
      && !BUSINESS_DOCUMENT_REVIEW_PATTERN.test(`${message.subject || ''}\n${currentText}`);
    const deletedDraft = Boolean(message.isDraft || message.isDraftFolder)
      && Boolean(message.isDeletedFolder || message.isJunkFolder);
    const deletedDraftAgeDays = deletedDraft ? messageAgeDays(message, nowValue) : null;
    const recentDeletedDraft = deletedDraft
      && (deletedDraftAgeDays == null || deletedDraftAgeDays <= 7);
    const lowReference = Boolean(message.isPromotional && !businessRecordDetails)
      || (Boolean(message.isDeletedFolder || message.isJunkFolder) && !recentDeletedDraft)
      || (LOW_VALUE_AUTOMATED_REFERENCE_PATTERN.test(`${message.subject || ''}\n${currentText}`)
        && (!businessRecordDetails || isInvoiceFolder(message)))
      || attachmentOnlyReference(message, currentText)
      || genericVerification
      || lowInvoiceNotice
      || lowAutomaticDocument
      || (PROMOTIONAL_CONTENT_PATTERN.test(currentText) && !businessRecordDetails)
      || ((message.isDraft || message.isDraftFolder || message.isOutgoing)
        && (!bodyCurrentText || GREETING_ONLY_PATTERN.test(bodyCurrentText)));
    const importantReference = !lowReference && String(message.importance || '').toLowerCase() === 'high';
    return {
      priority: lowReference ? 'low' : importantReference ? 'high' : 'normal',
      priorityConfidence: lowReference ? 0.98 : importantReference ? 0.9 : 0.86,
      priorityEvidence: stateEvidence || clauses[0] || null,
      priorityRule: lowReference ? 'low-value-reference' : importantReference ? 'important-business-reference' : 'business-reference',
    };
  }
  const priorityClauses = focusedClauses(clauses, stateEvidence)
    .filter((clause) => !isPriorityBoilerplate(clause.text));
  const subjectClauses = clausesWithOffsets(String(message.subject || ''), 'subject', String(message.id || ''));
  const urgentClause = firstMatching(priorityClauses, URGENT_PATTERN)
    || firstMatching(subjectClauses, EXPLICIT_THREAD_URGENCY_PATTERN);
  const incidentClause = firstMatching(priorityClauses, INCIDENT_SECURITY_PATTERN);
  const remoteSupportClause = firstMatching(priorityClauses, REMOTE_SUPPORT_ESCALATION_PATTERN)
    || firstMatching(clauses, REMOTE_SUPPORT_ESCALATION_PATTERN);
  const now = new Date(nowValue);
  const dueAt = due.dueAt ? new Date(due.dueAt) : null;
  const hours = dueAt ? (dueAt.getTime() - now.getTime()) / (60 * 60 * 1000) : null;
  const dueSoon48 = hours != null && hours >= -12 && hours <= 48;
  const dueSoon24 = hours != null && hours >= -12 && hours <= 24;

  if (signals.includes('incident_security') && urgentClause) {
    return { priority: 'critical', priorityConfidence: 0.94, priorityEvidence: incidentClause || urgentClause, priorityRule: 'urgent-incident' };
  }
  if (workState === 'action_required' || workState === 'decision_required') {
    if (urgentClause || remoteSupportClause || dueSoon48) {
      return {
        priority: 'high',
        priorityConfidence: 0.9,
        priorityEvidence: urgentClause || remoteSupportClause || dueEvidenceClause(clauses, due) || stateEvidence,
        priorityRule: urgentClause ? 'explicit-urgency' : remoteSupportClause ? 'remote-support-escalation' : 'due-within-48h',
      };
    }
    const verifiedActions = verifiedActionClauses(clauses);
    return {
      priority: 'normal',
      priorityConfidence: verifiedActions.length > 1 ? 0.88 : 0.82,
      priorityEvidence: stateEvidence || verifiedActions[0] || clauses[0] || null,
      priorityRule: verifiedActions.length > 1 ? 'multiple-actions-without-urgency' : 'action-default',
    };
  }
  if (workState === 'waiting') {
    if (urgentClause || dueSoon24) {
      return {
        priority: 'high',
        priorityConfidence: 0.86,
        priorityEvidence: urgentClause || dueEvidenceClause(clauses, due) || stateEvidence || clauses[0],
        priorityRule: urgentClause ? 'waiting-explicit-urgency' : 'waiting-deadline',
      };
    }
    return { priority: 'normal', priorityConfidence: 0.78, priorityEvidence: stateEvidence || clauses[0] || null, priorityRule: 'waiting-default' };
  }
  if (workState === 'review_required') {
    const securityAlertClause = firstMatching([...subjectClauses, ...clauses], SECURITY_VERIFICATION_ALERT_PATTERN);
    const securityAlert = SECURITY_VERIFICATION_ALERT_PATTERN.test(`${message.subject || ''}\n${currentText}`);
    const highReview = urgentClause || securityAlert;
    return {
      priority: highReview ? 'high' : 'normal',
      priorityConfidence: highReview ? 0.82 : 0.55,
      priorityEvidence: urgentClause || securityAlertClause || stateEvidence || clauses[0] || null,
      priorityRule: urgentClause ? 'review-with-urgency' : securityAlertClause ? 'security-alert-review' : 'review-default',
    };
  }
  return { priority: 'low', priorityConfidence: 0.95, priorityEvidence: clauses[0] || null, priorityRule: 'non-action-low' };
}

function dueEvidenceClause(clauses, due) {
  if (!due.dueText) return null;
  return clauses.find((clause) => normalizeComparable(clause.text).includes(normalizeComparable(due.dueText)))
    || clauses.find((clause) => /오늘|내일|모레|금주|이번\s*주|다음\s*주|\d{4}[.-]\d{1,2}[.-]\d{1,2}|\d{1,2}월\s*\d{1,2}일/.test(clause.text))
    || null;
}

function exactTermClause(sourceText, term, sourceField, sourceMessageId) {
  const source = String(sourceText || '');
  const needle = String(term || '');
  if (!source || !needle) return null;
  const index = source.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return null;
  const exactText = source.slice(index, index + needle.length);
  return {
    text: exactText,
    exactText,
    start: index,
    end: index + exactText.length,
    startOffset: index,
    endOffset: index + exactText.length,
    sourceField,
    sourceMessageId: String(sourceMessageId || ''),
    sourceText: source,
  };
}

export function validateClassificationEvidence(classification = {}, message = {}) {
  const history = splitMessageHistory(message.body || message.bodyPreview || '');
  const sources = {
    subject: String(message.subject || ''),
    body: history.currentContent,
    bodyPreview: splitMessageHistory(message.bodyPreview || '').currentContent,
  };
  const failures = [];
  for (const [field, item] of Object.entries(classification.evidence || {})) {
    if (!item || item.sourceField === 'user_correction') continue;
    const sourceText = sources[item.sourceField];
    if (typeof sourceText !== 'string') {
      failures.push({ field, reason: 'unknown_source_field' });
      continue;
    }
    const start = Number(item.startOffset ?? item.start);
    const end = Number(item.endOffset ?? item.end);
    const exactText = String(item.exactText ?? item.text ?? '');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > sourceText.length) {
      failures.push({ field, reason: 'invalid_offsets' });
      continue;
    }
    if (sourceText.slice(start, end) !== exactText) failures.push({ field, reason: 'span_mismatch' });
    if (item.sourceHash !== createHash('sha256').update(sourceText).digest('hex')) failures.push({ field, reason: 'source_hash_mismatch' });
    if (item.normalizationVersion !== EVIDENCE_NORMALIZATION_VERSION) failures.push({ field, reason: 'normalization_version_mismatch' });
  }
  return { ok: failures.length === 0, failures };
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
    operational: classification.operational
      ? {
        version: classification.operational.version,
        lane: classification.operational.lane,
        archiveEligible: classification.operational.archiveEligible,
        requiresHumanReview: classification.operational.requiresHumanReview,
        silentRiskPrevented: classification.operational.silentRiskPrevented,
        riskSignals: [...(classification.operational.riskSignals || [])].sort(),
      }
      : null,
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
  mailboxAddresses = [],
  now = new Date(),
  source = 'rules',
  provider = 'rules',
  model = '',
  promptVersion = PRECISION_CLASSIFICATION_VERSION,
} = {}) {
  const sourceMessageId = String(message.id || '');
  const subjectSource = String(message.subject || '');
  const history = splitMessageHistory(message.body || message.bodyPreview || '');
  const bodySource = history.currentContent;
  const stateSubject = THREAD_CONTEXT_SUBJECT_PATTERN.test(subjectSource.trim()) ? '' : subjectSource;
  const currentText = [stateSubject, bodySource].filter(Boolean).join('\n');
  const clauses = [
    ...clausesWithOffsets(stateSubject, 'subject', sourceMessageId),
    ...clausesWithOffsets(bodySource, 'body', sourceMessageId),
  ];
  let state = stateAndEvidence(clauses, currentText);
  const promotionalBySource = Boolean(message.isPromotional);
  const promotionalByContent = PROMOTIONAL_CONTENT_PATTERN.test(currentText);
  const strongPromotionalException = Boolean(
    state.stateEvidence
    && hasConcreteRequest(state.stateEvidence.text)
    && ACTION_OBJECT_PATTERN.test(state.stateEvidence.text)
    && /(?:오늘|내일|금일|이번\s*주|\d{1,2}월\s*\d{1,2}일|\d{4}[.-]\d{1,2}[.-]\d{1,2}|회신|제출|보내\s*주세요)/i.test(state.stateEvidence.text)
  );
  if (promotionalBySource || (promotionalByContent && !strongPromotionalException)) {
    const promotionalEvidence = firstMatching(clauses, PROMOTIONAL_CONTENT_PATTERN) || clauses[0] || null;
    state = {
      workState: 'reference',
      stateConfidence: 0.96,
      stateEvidence: promotionalEvidence,
      stateRule: 'promotional-no-explicit-user-action',
      reviewReasons: [],
    };
  }
  const sender = normalizeComparable(message.from || message.senderEmail || '');
  const ownAddresses = new Set([mailboxAddress, ...(mailboxAddresses || [])].map(normalizeComparable).filter(Boolean));
  const directionalMessage = {
    ...message,
    mailboxAddress,
    mailboxAddresses,
    isOutgoing: !message.isDraftFolder && !message.isDraft
      && (Boolean(message.isOutgoing) || ownAddresses.has(sender)),
  };
  const eventFrame = extractMailEventFrame({
    message: directionalMessage,
    clauses,
    currentText,
    baseState: state,
  });
  const eventDecision = decisionFromMailEventFrame(eventFrame);
  const automaticNotificationDirective = /자동\s*시스템\s*알림/i.test(currentText)
    && clauses.some((clause) => (
      clause.sourceField === 'body'
      && /(?:오늘|금일|내일).{0,48}(?:보내|제출).{0,24}(?:주세요|바랍니다)/i.test(clause.text)
    ));
  const adjustedState = adjustedStateForMessage(directionalMessage, state, clauses, currentText, now);
  const selectedState = directionalMessage.isDeletedFolder
    || directionalMessage.isJunkFolder
    || directionalMessage.isDraft
    || directionalMessage.isDraftFolder
    ? adjustedState
    : eventDecision || adjustedState;
  state = automaticNotificationDirective
    ? {
      workState: 'action_required',
      stateConfidence: 0.96,
      stateEvidence: clauses.find((clause) => clause.sourceField === 'body'
        && /(?:오늘|금일|내일).{0,48}(?:보내|제출).{0,24}(?:주세요|바랍니다)/i.test(clause.text)) || null,
      stateRule: 'automatic-notification-current-directive',
      reviewReasons: [],
    }
    : selectedState;
  const actor = state.nextActorHint
    ? {
      nextActor: state.nextActorHint,
      actorConfidence: state.stateConfidence,
      actorEvidence: state.stateEvidence,
      actorRule: `event:${state.eventType || 'decision'}`,
    }
    : actorAndEvidence(directionalMessage, currentText, clauses, state.workState, state.stateEvidence, mailboxAddress, mailboxAddresses);
  let due = extractDue(
    dueInputText(clauses, state.stateEvidence),
    message.receivedAt || now,
  );
  if (['reference', 'completed'].includes(state.workState)) {
    due = { dueText: '', dueAt: null, duePrecision: 'none', confidence: 0 };
  }
  const signals = supportingSignals(directionalMessage, currentText, clauses, state.stateEvidence, due);
  const project = resolveProject({ ...directionalMessage, body: bodySource, bodyPreview: bodySource }, projects);
  const priority = state.priorityHint
    ? {
      priority: state.priorityHint,
      priorityConfidence: state.stateConfidence,
      priorityEvidence: state.priorityEvidenceHint || state.stateEvidence,
      priorityRule: state.priorityRuleHint || `event:${state.eventType || 'decision'}`,
    }
    : priorityAndEvidence(directionalMessage, currentText, clauses, state.workState, state.stateEvidence, due, signals, now);
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
    project: (() => {
      const term = project.projectCandidate?.matchedTerm || project.projectCandidate?.label || '';
      if (!term) return null;
      const sourceField = project.projectCandidate?.source === 'body' ? 'body' : 'subject';
      const sourceText = sourceField === 'body' ? bodySource : subjectSource;
      return evidence(
        exactTermClause(sourceText, term, sourceField, sourceMessageId),
        'project',
        `project-${project.projectCandidate?.source || 'candidate'}`,
      );
    })(),
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
    eventFrame: {
      version: MAIL_EVENT_FRAME_VERSION,
      primaryType: state.eventType || '',
      conflicts: state.eventConflicts || [],
    },
    contentBoundary: { type: history.boundaryType, line: history.boundaryLine },
    source,
    provider,
    model,
    promptVersion,
    analyzedAt: new Date(now).toISOString(),
  };
  classification.operational = deriveOperationalClassification(classification, {
    message: directionalMessage,
    eventFrame,
  });
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
      const correctionText = correction.note || correction.reasonCode || '사용자 보정';
      next.evidence[confidenceField] = {
        field: confidenceField,
        sourceField: 'user_correction',
        sourceMessageId: String(classification.messageId || ''),
        startOffset: 0,
        endOffset: correctionText.length,
        exactText: correctionText,
        text: correctionText,
        sourceHash: createHash('sha256').update(correctionText).digest('hex'),
        normalizationVersion: EVIDENCE_NORMALIZATION_VERSION,
        start: 0,
        end: correctionText.length,
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
  next.operational = deriveOperationalClassification(next, {
    eventFrame: {
      events: [],
      conflicts: classification.eventFrame?.conflicts || [],
    },
  });
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
    operational: operationalSummary(classifications),
  };
}
