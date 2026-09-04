export const MAIL_EVENT_FRAME_VERSION = 'mail-event-frame-v3';

const EVENT_STATE_MACHINE_VERSION = 'mail-lifecycle-state-machine-v1.2.2';

const EVENT_FAMILY_BY_TYPE = Object.freeze({
  empty_message_reference: 'automated_reference',
  empty_message_review: 'ambiguous',
  lifecycle_reference: 'automated_reference',
  editorial_guide_reference: 'automated_reference',
  passive_payment_reference: 'automated_reference',
  automated_process_reference: 'automated_reference',
  automated_invoice_reference: 'automated_reference',
  archived_tax_invoice_reference: 'automated_reference',
  bulk_subject_notice_reference: 'automated_reference',
  automated_notification_reference: 'automated_reference',
  marketing_reference: 'automated_reference',
  access_information_reference: 'informational',
  informational_asset_reference: 'informational',
  delivery_failure_action: 'user_action',
  procurement_deadline_action: 'user_action',
  document_package_urgent_action: 'user_action',
  support_handoff_action: 'user_action',
  support_remote_availability_action: 'user_action',
  incoming_collaboration_invite_action: 'user_action',
  support_incoming_request_action: 'user_action',
  support_close_approval: 'user_action',
  concrete_question_action: 'user_action',
  inbound_followup_action: 'user_action',
  service_continuity_action: 'user_action',
  financial_limit_risk_action: 'user_action',
  subscription_followup_action: 'user_action',
  shared_access_verification: 'user_action',
  active_component_incident: 'incident_security',
  active_incident_action: 'incident_security',
  support_acknowledged_waiting: 'external_commitment',
  support_pending_response: 'external_commitment',
  support_remote_availability: 'external_commitment',
  support_provider_request_waiting: 'external_commitment',
  support_schedule_confirmed: 'external_commitment',
  outgoing_delivery_waiting_for_recipient: 'external_commitment',
  outgoing_commercial_quote_delivery_waiting: 'external_commitment',
  outgoing_request_waiting: 'external_commitment',
  support_resolved: 'completion',
  support_artifact_delivered: 'completion',
  inbound_acknowledgement_completed: 'completion',
  inbound_substantive_fulfillment_completed: 'completion',
  inbound_fulfillment_completed: 'completion',
  business_process_completed: 'completion',
  outgoing_delivery_completed: 'completion',
  outgoing_response_completed: 'completion',
  outgoing_substantive_response_completed: 'completion',
  progress_update_review: 'ambiguous',
  inbound_business_document_review: 'business_document',
  received_tax_invoice_review: 'business_document',
  current_action_urgency: 'urgency',
});

const EVENT_FAMILY_WEIGHT = Object.freeze({
  incident_security: 9000,
  user_action: 8000,
  external_commitment: 7000,
  completion: 6000,
  business_document: 5000,
  ambiguous: 4500,
  informational: 4000,
  automated_reference: 3500,
  urgency: 0,
});

const STRONG_PASSIVE_EVENT_TYPES = new Set([
  'lifecycle_reference',
  'marketing_reference',
  'passive_payment_reference',
  'automated_invoice_reference',
  'archived_tax_invoice_reference',
  'automated_process_reference',
  'editorial_guide_reference',
]);

const STATE_MACHINE_CONFLICT_PAIRS = new Set([
  'completion:user_action',
  'completion:external_commitment',
  'business_document:user_action',
  'automated_reference:user_action',
  'ambiguous:user_action',
  'ambiguous:external_commitment',
]);

const SUPPORT_CONTEXT_PATTERN = /(?:\b(?:ticket|case)\s*#?\s*[A-Z0-9-]{5,}|support\s+(?:ticket|case|staff)|기술\s*지원\s*(?:티켓|케이스))/i;
const SUPPORT_CLOSE_APPROVAL_PATTERN = /(?:may\s+i\s+know\s+if.{0,100}(?:resolved|working)|seek\s+(?:your\s+)?approval\s+to\s+close|(?:may|can|could|shall)\s+we\s+close|is\s+it\s+okay\s+to\s+close|close\s+(?:the\s+)?ticket\s*\?|(?:티켓|케이스).{0,36}(?:종료|닫).{0,24}(?:승인|괜찮|될까요|가능|회신)|(?:종료|닫).{0,24}(?:해도|하여도).{0,16}(?:될까요|괜찮))/i;
const SUPPORT_RESOLUTION_PATTERN = /(?:issue|problem|patch|service).{0,64}(?:has\s+been\s+resolved|is\s+resolved|good\s+to\s+work|works?\s+now|working\s+now)|you\s+can\s+close\s+(?:the\s+)?ticket|(?:문제|이슈|장애).{0,32}(?:해결|정상화|조치\s*완료)|(?:티켓|케이스).{0,24}(?:종료|닫).{0,16}(?:해주세요|바랍니다)/i;
const SUPPORT_ARTIFACT_DELIVERY_PATTERN = /(?:we\s+have\s+attach(?:ed)?|please\s+find\s+attached|첨부(?:드립니다|했습니다)|전달(?:드립니다|했습니다)|송부(?:드립니다|했습니다)).{0,120}(?:patch|log|dump|file|image|report|패치|로그|파일|이미지|자료)|(?:patch|log|dump|file|image|report|패치|로그|파일|이미지|자료).{0,120}(?:attach(?:ed)?|provided|첨부(?:드립니다|했습니다|되어)|전달(?:드립니다|했습니다)|송부(?:드립니다|했습니다))/i;
const SUPPORT_SCHEDULE_PATTERN = /(?:scheduled|confirmed|let'?s\s+make\s+it|we\s+can\s+make\s+it|(?:we|i)\s+(?:will|'?ll)\s+(?:connect|join|start|provide\s+support)).{0,100}(?:today|tomorrow|\d{1,2}(?::\d{2})?\s*(?:am|pm)|gmt[+-]?\d*|오늘|내일|오전|오후)|(?:오늘|내일|tomorrow).{0,80}(?:지원|방문|세션|접속|connect|join|schedule|works|confirmed)/i;
const SUPPORT_REMOTE_AVAILABILITY_PATTERN = /(?:we|i)\s+can\s+(?:remote|connect|join).{0,64}(?:today|tomorrow|any\s*time)|(?:today|tomorrow).{0,64}(?:remote|connect|join).{0,32}(?:available|possible|works)/i;
const SUPPORT_REMOTE_AVAILABILITY_ACTION_PATTERN = /(?:(?:may|can|could|would|will)\s+(?:you|we).{0,72}(?:remote|connect|join|support).{0,72}(?:today|tomorrow)|(?:today|tomorrow).{0,72}(?:remote\s*(?:support|session)?|connect|join).{0,48}(?:available|possible|work|가능)).{0,12}\?/i;
const SUPPORT_ACKNOWLEDGED_WAITING_PATTERN = /(?:request|case|ticket).{0,80}(?:has\s+been\s+received|was\s+received|is\s+received).{0,120}(?:will\s+be\s+reviewed|support\s+staff.{0,32}get\s+back|under\s+review)|(?:support\s+staff|support\s+team).{0,80}(?:will\s+review|will\s+get\s+back|is\s+reviewing)/i;
const SUPPORT_PENDING_RESPONSE_PATTERN = /(?:require|need)\s+(?:some\s+)?additional\s+time.{0,100}(?:internal\s+verification|investigat|confirm(?:ed)?\s+response)|(?:internal\s+verification|investigat).{0,100}(?:before\s+providing|will\s+update|confirmed\s+response)|(?:currently|still)\s+(?:checking|investigating|verifying).{0,80}(?:update|response|reply)/i;
const SUPPORT_HANDOFF_ACTION_PATTERN = /(?:need|have)\s+to\s+contact.{0,80}(?:sales|account|partner|reseller|vendor|licen[cs]e)\s+team|only\s+(?:the\s+)?(?:sales|account|partner|reseller|vendor)\s+team.{0,80}(?:authori[sz]ed|permission)|(?:do\s+not|don't)\s+have\s+permission.{0,120}(?:licen[cs]e|gateway|device)|(?:영업|총판|파트너|공급사).{0,40}(?:문의|연락|요청).{0,40}(?:필요|바랍니다)/i;
const SUPPORT_PROVIDER_REQUEST_PATTERN = /(?:빠른|긴급|즉시|금일|오늘)?.{0,32}(?:조치|해결|복구|확인|발급|생성|갱신|초기화|원격|삭제|해제).{0,40}(?:부탁|요청|필요|바랍니다)|(?:please|kindly).{0,28}(?:fix|resolve|restore|issue|generate|renew|reset|connect|remote|clear|remove)|(?:발급|조치|해결|복구|삭제|해제).{0,28}(?:부탁|요청)/i;
const SUPPORT_ROLE_RECIPIENT_PATTERN = /(?:support|helpdesk|service\s*desk|sales|account\s*team|licen[cs]e|technical\s*team|기술\s*지원|고객\s*지원|영업|총판|파트너)/i;
const INCOMING_COLLABORATION_ACTION_PATTERN = /(?:(?:you(?:'re| are)?\s+invited|invitation\s+(?:to|from)|shared\s+(?:workspace|project|folder)).{0,120}\b(?:accept|open|review)\b|(?:notion.{0,120}(?:invite|초대)|(?:초대|공유).{0,120}(?:수락|열어|검토)))/i;
const COLLABORATION_EXPLICIT_ACTION_CUE_PATTERN = /(?:please|kindly|action\s+required|required|must|need\s+to|액션\s*필요|(?:수락|열어|검토).{0,24}(?:해\s*주|하세요|바랍니다|필요))/i;
const COLLABORATION_ACTION_EXCLUSION_PATTERN = /(?:promo(?:tional)?|webinar|unsubscribe|수신\s*거부|expired?|만료|already\s+accepted|이미\s*수락)/i;

const SERVICE_CONTINUITY_ACTION_PATTERN = /(?:\[?action\s+required\]?\s*)?.{0,80}(?:subscription|account|service|workspace|구독|계정|서비스).{0,80}(?:currently\s+inactive|inactive|deactivat(?:e|ed|ion)|suspend(?:ed|sion)|disabled?|비활성화|중지|해지).{0,64}(?:soon|예정|유지|keep|reactivate|renew|login|sign\s+in|action\s+required)?|jump\s+back\s+in.{0,40}keep\s+your\s+subscription/i;
const MARKETING_UNSUBSCRIBE_PATTERN = /(?:marketing|newsletter|promotional|광고|마케팅).{0,96}(?:unsubscribe|구독.{0,20}해지|수신.{0,12}거부)|(?:unsubscribe|수신.{0,12}거부).{0,120}(?:marketing|newsletter|광고|마케팅|구독.{0,20}해지)/i;
const CARD_LIMIT_RISK_PATTERN = /(?:카드|credit\s*card).{0,64}(?:한도\s*(?:초과|소진)|limit.{0,24}(?:exceed|exhaust)|소진율.{0,16}(?:80|90|위험)).{0,80}(?:예상|임박|결제\s*실패|prepay|선결제|prevent|막아)/i;
const SUBSCRIPTION_FOLLOWUP_PATTERN = /(?:구독|subscription).{0,80}(?:심사|한도|eligibility|credit).{0,48}(?:완료|approved|complete).{0,80}(?:신청|apply|continue|activate|시작)|(?:심사|한도).{0,48}(?:완료).{0,80}(?:구독\s*신청|지금\s*바로)/i;
const SHARED_ACCESS_VERIFICATION_PATTERN = /(?:shared\s+(?:a\s+)?(?:folder|file)|folder\s+shared|폴더(?:가|를)?\s*공유|파일(?:이|을)?\s*공유).{0,160}(?:verify\s+your\s+email|email\s+verification|이메일을?\s*인증|인증해야)|(?:verify\s+your\s+email|이메일을?\s*인증).{0,160}(?:shared\s+(?:folder|file)|공유\s*(?:폴더|파일))/i;
const ACTIVE_INCIDENT_CONTEXT_PATTERN = /(?:현재|ongoing|active|발생|지속).{0,48}(?:장애|서비스\s*중단|접속\s*불가|outage|service\s+down|unavailable)|(?:장애|서비스\s*중단|접속\s*불가|outage|service\s+down|unavailable).{0,48}(?:발생|현재|지속|ongoing|active)/i;
const ACTIVE_INCIDENT_ACTION_PATTERN = /(?:즉시|긴급|금일|오늘).{0,32}(?:확인|조치|복구|해결|대응)|(?:확인|조치|복구|해결|대응).{0,32}(?:부탁|요청|필요)|please.{0,20}(?:investigate|fix|resolve|restore)/i;
const ACTIVE_SECURITY_INCIDENT_PATTERN = /(?:보안|security|침해|breach|malware|랜섬웨어|ransomware).{0,80}(?:장애|중단|접속\s*불가|outage|incident|발생)|(?:장애|중단|접속\s*불가|outage|incident).{0,80}(?:보안|security|침해|breach|malware|랜섬웨어|ransomware)/i;
const COMPONENT_OFFLINE_INCIDENT_PATTERN = /(?:gpu|node|server|host|cluster|storage|network|service|장비|노드|서버|호스트|스토리지|네트워크|서비스).{0,80}(?:offline|off-line|down|unavailable|오프라인|중단|접속\s*불가).{0,160}(?:alarm|alert|repeated|continues?|workload|vm|running|production|알람|경고|계속|반복|구동|운영|사용\s*중)|(?:alarm|alert|알람|경고).{0,120}(?:gpu|node|server|host|cluster|장비|노드|서버).{0,80}(?:offline|down|오프라인|중단)/i;
const CONCRETE_QUESTION_PATTERN = /(?:해야\s*(?:하는|되는)\s*(?:것|건)?\s*인가요|가능한가요|가능한지|(?:할|될)\s*수\s*있는지|맞나요|될까요|어떻게\s*(?:해야|하면)|무엇을\s*(?:해야|준비)|인지요|인가요)\s*[?.…]*|(?:is|are|can|could|should|would|do|does)\s+(?:it|we|i|this|the\s+system).{0,80}\?/i;
const ACTIONABLE_QUESTION_OBJECT_PATTERN = /agent|접근|설치|구축|정책|계정|사용자|서버|장비|라이선스|license|견적|입찰|계약|보안|장애|설정|configuration|access|install|deployment|system|device/i;

const DELIVERY_FAILURE_PATTERN = /(?:배달되지\s*않음|전달되지\s*않음|delivery\s+(?:has\s+)?failed|undeliverable|could\s+not\s+be\s+delivered|메시지를\s+배달할\s+수\s+없).{0,180}(?:작업\s*필요|action\s+required|다시\s*보내|연락|contact|resolve|해결)?/i;
const PROCUREMENT_DEADLINE_PATTERN = /(?:견적|입찰)(?:\s*\/\s*(?:견적|입찰))?\s*건이?\s*0\s*일\s*후\s*마감[\s\S]{0,320}(?:기한\s*내\s*)?(?:응찰|제출|접속)|(?:견적|입찰|응찰|tender|bid|quotation).{0,180}(?:(?:오늘|금일).{0,80}(?:마감|deadline|closing|due)|(?:마감|deadline|closing|due).{0,100}(?:오늘|금일|기한\s*내)).{0,220}(?:응찰|제출|submit|respond|접속)/i;
const PROCUREMENT_DEADLINE_EVIDENCE_PATTERN = /(?:견적|입찰|tender|bid|quotation).{0,100}(?:0\s*일|오늘|금일|마감|deadline|closing|due)|(?:기한\s*내\s*)?(?:응찰|제출|submit|respond)/i;
const DOCUMENT_PACKAGE_URGENCY_PATTERN = /(?:서류|자료|document).{0,180}(?:모두|all).{0,80}(?:회신|제출|보내|reply|submit).{0,100}(?:신속|빠른|바쁘시겠지만|urgently|promptly)|(?:신속|빠른|바쁘시겠지만).{0,120}(?:서류|자료).{0,80}(?:회신|제출|보내)/i;
const EDITORIAL_GUIDE_REFERENCE_PATTERN = /(?:법인세|부가세|세무|세금|tax).{0,100}(?:총정리|가이드|체크리스트|한눈에|알아보기|핵심\s*정리)|(?:총정리|가이드|체크리스트|한눈에|핵심\s*정리).{0,100}(?:법인세|부가세|세무|세금|tax)/i;

const BUSINESS_PROCESS_COMPLETION_PATTERN = /(?:검수|승인|결재|등록|발행|처리|계약|주문).{0,40}(?:요청\s*)?(?:승인|처리|등록|발행|완료).{0,24}(?:완료\s*(?:되었습니다|됐습니다|됨)|처리\s*(?:되었습니다|됐습니다))|(?:approval|inspection|registration|issuance).{0,48}(?:has\s+been\s+)?completed/i;
const PASSIVE_PROCESS_COMPLETION_PATTERN = /(?:구매|조달|procurement|portal|포탈|포털).{0,80}(?:검수|승인|approval|inspection).{0,80}(?:완료|completed)|(?:검수\s*요청\s*승인|approval\s+request).{0,48}(?:완료|completed)/i;
const PASSIVE_PAYMENT_RECEIPT_PATTERN = /(?:결제\s*(?:확인|완료|내역)|payment\s+(?:confirmation|receipt|completed)).{0,120}(?:결제하신\s*내역|승인\s*번호|receipt|transaction|자동\s*발송|발신\s*전용)|(?:결제하신\s*내역|payment\s+receipt).{0,120}(?:금액|승인|transaction)/i;
const PASSIVE_NOTIFICATION_PATTERN = /(?:^|\b)(?:notification|알림|안내)(?:\s+from|\s*[:：]|\s*$)|새\s*메시지\s*\(발신\s*:/i;
const PROGRESS_UPDATE_REVIEW_PATTERN = /(?:중간\s*보고|진행\s*현황|progress\s+update).{0,240}(?:완료|적용|등록|반영)|(?:초기|일부|현재).{0,80}(?:적용|등록|구성).{0,80}(?:완료|마쳤).{0,180}(?:최종|추가).{0,80}(?:진행|반영|예정)/i;
const INBOUND_FULFILLMENT_PATTERN = /(?:요청하신|문의하신).{0,80}(?:견적서|제안서|자료|파일|정보|답변|사항).{0,80}(?:전달|송부|첨부|회신|반영|검토).{0,32}(?:드립니다|드렸습니다|했습니다|완료)|(?:견적서|제안서|자료|파일|정보|답변).{0,80}(?:전달|송부|첨부|회신).{0,32}(?:드립니다|드렸습니다|했습니다)|(?:도입\s*사례|구성|내용).{0,80}(?:추가|반영).{0,48}(?:송부|전달)\s*드립니다/i;
const BUSINESS_DOCUMENT_DELIVERY_REVIEW_PATTERN = /(?:재)?견적(?:서)?|제안서|계약서|발주서|주문서|quotation|proposal|purchase\s*order|contract\s*document/i;
const SUBSTANTIVE_FULFILLMENT_DETAIL_PATTERN = /(?:설치\s*비용|현장\s*상황|stacking|mlag|데이터\s*시트|data\s*sheet|datasheet|지원\s*(?:합니다|됩니다)|기능|사양|구성|제약|비용은)/i;
const INBOUND_ACKNOWLEDGED_COMPLETION_PATTERN = /(?:요청하신|전달하신).{0,64}(?:사항|내용|자료).{0,48}(?:잘\s*)?(?:전달\s*받았습니다|확인했습니다|접수했습니다)|(?:requested|provided).{0,80}(?:received|reviewed|confirmed)/i;
const ACCESS_INFORMATION_REFERENCE_PATTERN = /(?:vpn|hci|portal|포털|시스템).{0,48}(?:접속|access).{0,80}(?:정보|계정|주소|url)|(?:설치\s*파일|다운로드\s*링크|접속\s*계정|access\s+(?:details|credentials|information)).{0,80}(?:전달|공유|provided|sent)/i;
const INBOUND_FOLLOWUP_ACTION_PATTERN = /(?:반입|송부|제출|발급|회신|보내|준비|설치|등록|수정).{0,48}(?:해\s*주시면|하여\s*주시|부탁(?:드립니다|합니다)?|요청(?:드립니다|합니다)?|주시기\s*바랍니다|해\s*주세요)/i;
const INBOUND_FOLLOWUP_OBJECT_PATTERN = /견적|제안|계약|발주|라이선스|license|파일|자료|서류|문서|설치|반입|계정|사용자|장비|quote|proposal|contract|purchase\s*order|document|file/i;
const INFORMATIONAL_ASSET_DELIVERY_PATTERN = /(?:장비\s*정보|현황표|라이선스\s*현황|라이센스\s*현황|license\s+inventory|status\s+(?:sheet|list)).{0,96}(?:전달|송부|첨부|공유|provided|sent)|(?:전달|송부|첨부|공유|provided|sent).{0,96}(?:장비\s*정보|현황표|라이선스\s*현황|라이센스\s*현황|license\s+inventory|status\s+(?:sheet|list))/i;
const INVOICE_READY_REFERENCE_PATTERN = /(?:청구서|invoice).{0,60}(?:준비되었습니다|is\s+ready|ready\s+for\s+review|available)/i;
const INVOICE_PASSIVE_CONTEXT_PATTERN = /(?:자동으로\s*청구|automatically\s+charged|이미\s*결제한\s*경우|if\s+already\s+paid|view\s+(?:the\s+)?invoice|청구서\s*보기|검토하려면\s*로그인)/i;
const TAX_INVOICE_NOTICE_PATTERN = /(?:전자)?세금계산서.{0,80}(?:확인했습니다|확인\s*완료|발급\s*메일\s*안내|발급하고\s*발송|발행되었습니다)|(?:tax\s+invoice).{0,64}(?:issued|confirmed|available)/i;
const BULK_ROUTING_BODY_PATTERN = /^\s*(?:수신|to)\s*[:：].{0,80}(?:발신|from)\s*[:：].{0,80}$/i;
const BULK_SUBJECT_REQUEST_PATTERN = /(?:요청|request|제출|발행|검수|세금계산서|발주서)/i;

const OUTGOING_PAST_ACTION_PATTERN = /(?:기입|등록|제출|반영|처리|답변|회신|전달|송부|첨부|보내).{0,20}(?:하였습니다|했습니다|드렸습니다|드립니다|완료했습니다)|(?:have\s+)?(?:entered|registered|submitted|updated|answered|sent|attached|provided)\b/i;
const OUTGOING_DELIVERY_PATTERN = /(?:견적서|제안서|계약서|발주서|자료|파일|연락처|답변|정보|patch|report|quotation|proposal|document).{0,64}(?:전달|송부|첨부|회신|보내|sent|attached|provided)|(?:전달|송부|첨부|회신|보내|sent|attached|provided).{0,64}(?:견적서|제안서|계약서|발주서|자료|파일|연락처|답변|정보|patch|report|quotation|proposal|document)/i;
const RECIPIENT_RESPONSE_REQUEST_PATTERN = /(?:확인|검토).{0,120}(?:해\s*주시면|후.{0,100}(?:회신|알려|답변)|결과.{0,80}(?:회신|알려))|(?:회신|답변|알려).{0,32}(?:부탁|바랍니다|주세요|주시면)|(?:수용\s*가능\s*여부|추가\s*협의).{0,100}(?:회신|답변)|please\s+(?:confirm|review|reply|respond)|let\s+me\s+know/i;
const INFORMATIONAL_COURTESY_REVIEW_PATTERN = /(?:오해|혼선)\s*없이.{0,24}(?:검토|확인)\s*(?:부탁|바랍니다)|for\s+your\s+(?:review|reference)\s+only/i;
const CONDITIONAL_FUTURE_OFFER_PATTERN = /(?:필요하신|원하시는|추가\s*필요).{0,48}(?:요청|말씀).{0,20}(?:주시면|해\s*주시면).{0,32}(?:전달|보내|공유|준비)\s*(?:드리겠습니다|하겠습니다)|if\s+you\s+need.{0,64}(?:let\s+me\s+know|we\s+can\s+provide)/i;
const OUTGOING_UNRESOLVED_COMMITMENT_PATTERN = /(?:will|shall|plan\s+to|intend\s+to).{0,48}(?:send|attach|provide|share)|(?:전달|송부|첨부|제공|공유).{0,32}(?:드리겠습니다|하겠습니다|예정)/i;
const OUTGOING_REQUEST_PATTERN = /(?:요청드립니다|(?:보내|제출|발행|발주|전달|회신|확인|검토|수정|수용|협의)\s*(?:해\s*)?(?:주세요|주시기\s*바랍니다|부탁드립니다)|(?:회신|답변|확인|검토|수정|수용|협의).{0,18}(?:부탁드립니다|바랍니다)|please\s+(?:send|provide|confirm|review|reply|respond)|can\s+you|could\s+you|let\s+me\s+know)/i;
const OUTGOING_SUBSTANTIVE_RESPONSE_PATTERN = /(?:문의|질문|요청).{0,48}(?:사항|내용).{0,48}(?:검토|답변|회신).{0,32}(?:하였습니다|했습니다|드립니다)|(?:검토|답변|회신).{0,32}(?:결과|내용).{0,32}(?:다음과\s*같|아래와\s*같)/i;

const CURRENT_URGENCY_PATTERN = /(?:금일|오늘|내일).{0,40}(?:해결|조치|처리|회신|제출|확인).{0,20}(?:필요|부탁|요청|바랍니다)|(?:빠른|긴급|즉시).{0,20}(?:조치|처리|회신|해결|확인)|(?:resolve|fix|respond|submit).{0,24}(?:today|tomorrow|urgently|asap)/i;
const LEGAL_OR_CONTACT_BOILERPLATE_PATTERN = /(?:본\s*전자우편|this\s+(?:email|e-mail)).{0,160}(?:지정된\s*수신인|intended\s+recipient|confidential)|(?:잘못\s*전송|received\s+this\s+email\s+in\s+error).{0,120}(?:즉시|immediately).{0,80}(?:알린|notify|삭제|delete|파기|destroy)|(?:(?:추가|기타|further).{0,48}(?:문의|inquir|question)|궁금하신\s*사항).{0,64}(?:회신|reply|contact|연락)/i;

function normalizeSpace(value = '') {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function firstClause(clauses, pattern, { bodyOnly = false, excludeBoilerplate = false } = {}) {
  return clauses.find((clause) => {
    if (bodyOnly && clause.sourceField !== 'body') return false;
    if (excludeBoilerplate && LEGAL_OR_CONTACT_BOILERPLATE_PATTERN.test(clause.text)) return false;
    return pattern.test(clause.text);
  }) || null;
}

function firstSubjectOrBodyClause(clauses, pattern, options = {}) {
  return firstClause(clauses, pattern, options)
    || firstClause(clauses.filter((clause) => clause.sourceField === 'subject'), pattern, options);
}

function combinedEvidence(clauses, combined, combinedPattern, evidencePattern, options = {}) {
  if (!combinedPattern.test(combined)) return null;
  return firstSubjectOrBodyClause(clauses, evidencePattern || combinedPattern, options)
    || subjectEvidence(clauses)
    || bodyEvidence(clauses);
}

function event(type, rank, confidence, decision, evidence, attributes = {}) {
  return {
    type,
    rank,
    confidence,
    decision,
    evidence: evidence || null,
    attributes: {
      family: EVENT_FAMILY_BY_TYPE[type] || 'ambiguous',
      ...attributes,
    },
  };
}

function eventFamily(candidate) {
  return candidate?.attributes?.family
    || EVENT_FAMILY_BY_TYPE[candidate?.type]
    || 'ambiguous';
}

function eventPolicyScore(candidate, { lifecycle = 'active' } = {}) {
  const family = eventFamily(candidate);
  let score = Number(EVENT_FAMILY_WEIGHT[family] || 0) + Number(candidate?.rank || 0);

  if (candidate?.type === 'lifecycle_reference' && ['deleted', 'junk'].includes(lifecycle)) score += 20_000;
  if (candidate?.type === 'support_close_approval') score += 800;
  if (candidate?.type === 'support_incoming_request_action') score += 500;
  if (candidate?.type === 'support_handoff_action') score += 400;
  if (candidate?.type === 'incoming_followup_action') score += 350;
  if (candidate?.type === 'outgoing_delivery_waiting_for_recipient') score += 450;
  if (candidate?.type === 'outgoing_request_waiting') score += 400;
  if (candidate?.type === 'received_tax_invoice_review') score += 350;
  if (candidate?.type === 'empty_message_review') score += 300;

  if (candidate?.type === 'access_information_reference') score += 2800;
  if (candidate?.type === 'informational_asset_reference') score += 2600;
  if (candidate?.type === 'automated_invoice_reference') score += 2600;
  if (candidate?.type === 'archived_tax_invoice_reference') score += 2600;
  if (candidate?.type === 'passive_payment_reference') score += 2600;
  if (candidate?.type === 'marketing_reference') score += 2500;
  if (candidate?.type === 'editorial_guide_reference') score += 2500;
  if (candidate?.type === 'bulk_subject_notice_reference') score += 2400;

  if (STRONG_PASSIVE_EVENT_TYPES.has(candidate?.type)) score += 250;
  return score;
}

function conflictKey(left, right) {
  return [eventFamily(left), eventFamily(right)].sort().join(':');
}

function shouldRecordStateConflict(primary, candidate) {
  if (!primary || !candidate || primary === candidate) return false;
  if (candidate.type === 'current_action_urgency') return false;
  if (candidate.decision?.workState === primary.decision?.workState) return false;
  if (candidate.type === 'lifecycle_reference' || primary.type === 'lifecycle_reference') return false;
  if (STATE_MACHINE_CONFLICT_PAIRS.has(conflictKey(primary, candidate))) return true;
  return Math.abs(Number(candidate.policyScore || 0) - Number(primary.policyScore || 0)) <= 180;
}

function reconcileEvents(events, { lifecycle = 'active' } = {}) {
  const ranked = events
    .map((candidate) => ({
      ...candidate,
      policyScore: eventPolicyScore(candidate, { lifecycle }),
    }))
    .sort((left, right) => right.policyScore - left.policyScore
      || right.confidence - left.confidence
      || right.rank - left.rank);
  const primaryEvent = ranked.find((candidate) => candidate.type !== 'current_action_urgency')
    || ranked[0]
    || null;
  const conflicts = primaryEvent
    ? ranked.filter((candidate) => shouldRecordStateConflict(primaryEvent, candidate))
      .map((candidate) => candidate.type)
    : [];
  return {
    events: ranked,
    primaryEvent,
    conflicts: [...new Set(conflicts)],
    stateMachine: {
      version: EVENT_STATE_MACHINE_VERSION,
      selectedFamily: primaryEvent ? eventFamily(primaryEvent) : 'none',
      selectedType: primaryEvent?.type || '',
      selectedScore: primaryEvent?.policyScore || 0,
      candidateFamilies: [...new Set(ranked.map((candidate) => eventFamily(candidate)))],
      conflictCount: conflicts.length,
    },
  };
}

function isInvoiceFolder(message = {}) {
  return /세금계산서|tax\s*invoice|invoice/i.test(
    `${message.folderWellKnownName || ''}\n${message.folderName || ''}`,
  );
}

function normalizePartyName(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/주식회사|유한회사|사단법인|재단법인|㈜|\(주\)|[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function taxInvoiceDirectionFromSubject(subject = '') {
  const match = String(subject || '').match(/^\s*(.+?)\s*\((.+?)\s*[-=]?>\s*(.+?)\)\s*$/u);
  if (!match) return 'unknown';
  const outer = normalizePartyName(match[1]);
  const source = normalizePartyName(match[2]);
  const target = normalizePartyName(match[3]);
  if (!outer || !source || !target) return 'unknown';
  if (outer === source && outer !== target) return 'outgoing';
  if (outer === target && outer !== source) return 'incoming';
  return 'unknown';
}

function isLifecycleFolder(message = {}) {
  return Boolean(message.isDeletedFolder || message.isJunkFolder);
}

function subjectEvidence(clauses) {
  return clauses.find((clause) => clause.sourceField === 'subject') || clauses[0] || null;
}

function exactMessageSubjectEvidence(message = {}) {
  const sourceText = String(message.subject || '');
  const leading = sourceText.search(/\S/u);
  if (leading < 0) return null;
  const trailing = sourceText.match(/\s*$/u)?.[0]?.length || 0;
  const startOffset = leading;
  const endOffset = sourceText.length - trailing;
  if (endOffset <= startOffset) return null;
  const exactText = sourceText.slice(startOffset, endOffset);
  return {
    text: exactText,
    exactText,
    start: startOffset,
    end: endOffset,
    startOffset,
    endOffset,
    sourceField: 'subject',
    sourceMessageId: String(message.id || ''),
    sourceText,
  };
}

function bodyEvidence(clauses) {
  return clauses.find((clause) => clause.sourceField === 'body') || subjectEvidence(clauses);
}

function recipientValues(message = {}) {
  const values = [];
  for (const field of ['toRecipients', 'ccRecipients', 'bccRecipients', 'replyTo']) {
    for (const recipient of Array.isArray(message[field]) ? message[field] : []) {
      const address = recipient?.emailAddress?.address || recipient?.address || recipient?.email || '';
      const name = recipient?.emailAddress?.name || recipient?.name || '';
      if (address || name) values.push(`${address} ${name}`.trim());
    }
  }
  return values;
}

function hasSupportRoleRecipient(message = {}) {
  return recipientValues(message).some((value) => SUPPORT_ROLE_RECIPIENT_PATTERN.test(value));
}

function isOperationalAutomatedSender(message = {}) {
  const sender = String(message.from || message.senderEmail || '').trim();
  return /^(?:no[-_.]?reply|noreply|notification|notifications|alert|alerts|mailer-daemon|admin|system|portal|.+[-_.]admin)@/i.test(sender);
}

export function extractMailEventFrame({
  message = {},
  clauses = [],
  currentText = '',
  baseState = null,
} = {}) {
  const subject = normalizeSpace(message.subject || '');
  const bodyText = normalizeSpace(
    clauses.filter((clause) => clause.sourceField === 'body').map((clause) => clause.text).join(' '),
  );
  const combined = normalizeSpace(`${subject}\n${bodyText || currentText}`);
  const outgoing = Boolean(message.isOutgoing);
  const automated = Boolean(message.isPromotional) || isOperationalAutomatedSender(message);
  const events = [];
  const add = (candidate) => {
    if (candidate?.evidence || candidate?.attributes?.allowMissingEvidence) events.push(candidate);
  };

  const trulyEmpty = !subject
    && !bodyText
    && !normalizeSpace(message.from || message.senderEmail || message.fromName || '');
  if (trulyEmpty) {
    add(event('empty_message_reference', 1200, 0.99, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, null, { allowMissingEvidence: true }));
  }

  const contentEmpty = !subject && !bodyText;
  if (!trulyEmpty && contentEmpty && !isLifecycleFolder(message)) {
    add(event('empty_message_review', 1190, 0.98, {
      workState: 'review_required',
      nextActor: 'unknown',
      priority: 'normal',
    }, null, {
      allowMissingEvidence: true,
      attachmentOnly: Boolean(message.hasAttachments),
    }));
  }

  const deliveryFailure = firstSubjectOrBodyClause(clauses, DELIVERY_FAILURE_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && deliveryFailure) {
    add(event('delivery_failure_action', 1180, 0.99, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'high',
    }, deliveryFailure));
  }

  const procurementDeadline = PROCUREMENT_DEADLINE_PATTERN.test(combined)
    ? firstSubjectOrBodyClause(clauses, PROCUREMENT_DEADLINE_EVIDENCE_PATTERN, {
      excludeBoilerplate: true,
    })
    : null;
  if (!outgoing && procurementDeadline) {
    add(event('procurement_deadline_action', 1170, 0.98, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'high',
    }, procurementDeadline));
  }

  const componentIncident = firstSubjectOrBodyClause(clauses, COMPONENT_OFFLINE_INCIDENT_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && componentIncident) {
    add(event('active_component_incident', 1160, 0.98, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'critical',
    }, componentIncident));
  }

  const documentPackageUrgency = firstSubjectOrBodyClause(clauses, DOCUMENT_PACKAGE_URGENCY_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && documentPackageUrgency) {
    add(event('document_package_urgent_action', 1150, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'high',
    }, documentPackageUrgency));
  }

  const editorialGuide = EDITORIAL_GUIDE_REFERENCE_PATTERN.test(subject)
    ? exactMessageSubjectEvidence(message)
    : null;
  if (!outgoing && editorialGuide) {
    add(event('editorial_guide_reference', 1130, 0.98, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, editorialGuide));
  }

  if (isLifecycleFolder(message) && !message.isDraft && !message.isDraftFolder) {
    add(event('lifecycle_reference', 1000, 0.99, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, subjectEvidence(clauses) || bodyEvidence(clauses), {
      lifecycle: message.isJunkFolder ? 'junk' : 'deleted',
      allowMissingEvidence: true,
    }));
  }

  const activeIncident = (ACTIVE_INCIDENT_CONTEXT_PATTERN.test(combined)
    || ACTIVE_SECURITY_INCIDENT_PATTERN.test(combined))
    && ACTIVE_INCIDENT_ACTION_PATTERN.test(combined);
  if (!outgoing && activeIncident) {
    const incidentEvidence = firstClause(clauses, ACTIVE_INCIDENT_ACTION_PATTERN, { excludeBoilerplate: true })
      || firstSubjectOrBodyClause(clauses, ACTIVE_INCIDENT_CONTEXT_PATTERN, { excludeBoilerplate: true });
    const critical = ACTIVE_SECURITY_INCIDENT_PATTERN.test(combined)
      || /(?:긴급|즉시|critical|immediately)/i.test(incidentEvidence?.text || combined);
    add(event('active_incident_action', critical ? 1140 : 945, 0.98, {
      workState: 'action_required',
      nextActor: 'me',
      priority: critical ? 'critical' : 'high',
    }, incidentEvidence));
  }

  const supportContext = SUPPORT_CONTEXT_PATTERN.test(combined);
  if (supportContext) {
    const handoff = firstClause(clauses, SUPPORT_HANDOFF_ACTION_PATTERN, { excludeBoilerplate: true });
    if (handoff) {
      add(event('support_handoff_action', 985, 0.98, {
        workState: 'action_required',
        nextActor: 'me',
        priority: 'high',
      }, handoff));
    }

    const acknowledged = firstClause(clauses, SUPPORT_ACKNOWLEDGED_WAITING_PATTERN, { excludeBoilerplate: true });
    if (acknowledged && !handoff) {
      add(event('support_acknowledged_waiting', 980, 0.98, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, acknowledged));
    }

    const pendingResponse = firstClause(clauses, SUPPORT_PENDING_RESPONSE_PATTERN, { excludeBoilerplate: true });
    if (pendingResponse && !handoff) {
      add(event('support_pending_response', 979, 0.98, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, pendingResponse));
    }

    const remoteAvailability = firstClause(clauses, SUPPORT_REMOTE_AVAILABILITY_PATTERN, { excludeBoilerplate: true });
    if (remoteAvailability && !handoff) {
      add(event('support_remote_availability', 978, 0.96, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, remoteAvailability));
    }

    const remoteAvailabilityAction = firstClause(clauses, SUPPORT_REMOTE_AVAILABILITY_ACTION_PATTERN, { excludeBoilerplate: true });
    if (!outgoing
        && remoteAvailabilityAction
        && !handoff
        && !SUPPORT_RESOLUTION_PATTERN.test(combined)
        && !/(?:ticket|case).{0,48}(?:closed|종료|닫)/i.test(combined)) {
      add(event('support_remote_availability_action', 986, 0.97, {
        workState: 'action_required',
        nextActor: 'me',
        priority: 'high',
      }, remoteAvailabilityAction));
    }

    const providerRequest = firstClause(clauses, SUPPORT_PROVIDER_REQUEST_PATTERN, { excludeBoilerplate: true });
    if (providerRequest && hasSupportRoleRecipient(message) && !handoff) {
      const urgentProviderRequest = CURRENT_URGENCY_PATTERN.test(combined)
        || /(?:만료|expired?|invalid|동작하지\s*않|사용이\s*안|license.{0,32}(?:fail|invalid))/i.test(combined);
      add(event('support_provider_request_waiting', 975, 0.97, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: urgentProviderRequest ? 'high' : 'normal',
      }, providerRequest));
    }

    if (providerRequest && !outgoing && !hasSupportRoleRecipient(message) && !handoff) {
      const urgentIncomingRequest = CURRENT_URGENCY_PATTERN.test(combined)
        || /(?:만료|expired?|invalid|동작하지\s*않|사용이\s*안|license.{0,32}(?:fail|invalid))/i.test(combined);
      add(event('support_incoming_request_action', 975, 0.97, {
        workState: 'action_required',
        nextActor: 'me',
        priority: urgentIncomingRequest ? 'high' : null,
      }, providerRequest));
    }

    const closeApproval = firstClause(clauses, SUPPORT_CLOSE_APPROVAL_PATTERN, { excludeBoilerplate: true });
    if (closeApproval) {
      add(event('support_close_approval', 930, 0.98, {
        workState: 'action_required',
        nextActor: 'me',
        priority: 'normal',
      }, closeApproval));
    }

    const resolved = firstClause(clauses, SUPPORT_RESOLUTION_PATTERN, { excludeBoilerplate: true });
    if (resolved && !closeApproval) {
      add(event('support_resolved', 920, 0.98, {
        workState: 'completed',
        nextActor: 'none',
        priority: 'normal',
      }, resolved));
    }

    const artifact = firstClause(clauses, SUPPORT_ARTIFACT_DELIVERY_PATTERN, { excludeBoilerplate: true });
    if (artifact && !closeApproval && !resolved) {
      add(event('support_artifact_delivered', 910, 0.94, {
        workState: 'completed',
        nextActor: 'none',
        priority: 'normal',
      }, artifact));
    }

    const schedule = firstClause(clauses, SUPPORT_SCHEDULE_PATTERN, { excludeBoilerplate: true });
    if (schedule && !closeApproval && !resolved) {
      add(event('support_schedule_confirmed', 900, 0.94, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, schedule));
    }
  }

  const collaborationInvite = firstClause(clauses, INCOMING_COLLABORATION_ACTION_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing
      && collaborationInvite
      && !automated
      && COLLABORATION_EXPLICIT_ACTION_CUE_PATTERN.test(collaborationInvite.text)
      && !COLLABORATION_ACTION_EXCLUSION_PATTERN.test(combined)) {
    add(event('incoming_collaboration_invite_action', 973, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, collaborationInvite));
  }

  const progressUpdate = firstSubjectOrBodyClause(clauses, PROGRESS_UPDATE_REVIEW_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && !supportContext && progressUpdate) {
    add(event('progress_update_review', 970, 0.96, {
      workState: 'review_required',
      nextActor: 'unknown',
      priority: 'normal',
    }, progressUpdate));
  }

  const concreteQuestion = firstSubjectOrBodyClause(clauses, CONCRETE_QUESTION_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing
      && !automated
      && concreteQuestion
      && ACTIONABLE_QUESTION_OBJECT_PATTERN.test(combined)
      && !progressUpdate) {
    add(event('concrete_question_action', 974, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, concreteQuestion));
  }

  const accessInformation = firstSubjectOrBodyClause(clauses, ACCESS_INFORMATION_REFERENCE_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing
      && accessInformation
      && !concreteQuestion
      && !SHARED_ACCESS_VERIFICATION_PATTERN.test(combined)) {
    add(event('access_information_reference', 969, 0.95, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'normal',
    }, accessInformation));
  }

  const inboundFollowupAction = firstClause(clauses, INBOUND_FOLLOWUP_ACTION_PATTERN, {
    bodyOnly: true,
    excludeBoilerplate: true,
  });
  if (!outgoing
      && !supportContext
      && inboundFollowupAction
      && INBOUND_FOLLOWUP_OBJECT_PATTERN.test(inboundFollowupAction.text)
      && !['completed', 'decision_required'].includes(baseState?.workState)
      && !progressUpdate) {
    add(event('inbound_followup_action', 976, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: null,
    }, inboundFollowupAction));
  }

  const informationalAsset = firstSubjectOrBodyClause(clauses, INFORMATIONAL_ASSET_DELIVERY_PATTERN, {
    excludeBoilerplate: true,
  }) || (INFORMATIONAL_ASSET_DELIVERY_PATTERN.test(subject)
    ? exactMessageSubjectEvidence(message)
    : null);
  if (!outgoing && informationalAsset && !inboundFollowupAction && !concreteQuestion) {
    add(event('informational_asset_reference', 968, 0.96, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'normal',
    }, informationalAsset));
  }

  const inboundFulfillment = firstClause(clauses, INBOUND_FULFILLMENT_PATTERN, {
    bodyOnly: true,
    excludeBoilerplate: true,
  });
  const inboundAcknowledged = firstClause(clauses, INBOUND_ACKNOWLEDGED_COMPLETION_PATTERN, {
    bodyOnly: true,
    excludeBoilerplate: true,
  });
  if (!outgoing
      && inboundAcknowledged
      && !supportContext
      && !progressUpdate
      && !inboundFollowupAction
      && !concreteQuestion) {
    add(event('inbound_acknowledgement_completed', 979, 0.97, {
      workState: 'completed',
      nextActor: 'none',
      priority: 'normal',
    }, inboundAcknowledged));
  }
  const promisedAttachmentMissing = !message.hasAttachments
    && /(?:첨부|attachment|attached)/i.test(inboundFulfillment?.text || combined);
  const businessDocumentDelivery = inboundFulfillment
    && BUSINESS_DOCUMENT_DELIVERY_REVIEW_PATTERN.test(`${subject}\n${inboundFulfillment.text}`);
  const substantiveBusinessResponse = businessDocumentDelivery
    && SUBSTANTIVE_FULFILLMENT_DETAIL_PATTERN.test(combined);
  if (!outgoing
      && substantiveBusinessResponse
      && !supportContext
      && !progressUpdate
      && !inboundFollowupAction
      && !concreteQuestion) {
    add(event('inbound_substantive_fulfillment_completed', 971, 0.96, {
      workState: 'completed',
      nextActor: 'none',
      priority: 'normal',
    }, inboundFulfillment));
  }
  if (!outgoing
      && businessDocumentDelivery
      && !substantiveBusinessResponse
      && !supportContext
      && !progressUpdate
      && !inboundFollowupAction
      && !concreteQuestion
      && baseState?.workState !== 'action_required'
      && !(baseState?.workState === 'reference' && promisedAttachmentMissing)) {
    add(event('inbound_business_document_review', 969, 0.96, {
      workState: 'review_required',
      nextActor: 'unknown',
      priority: 'normal',
    }, inboundFulfillment));
  }
  if (!outgoing
      && !supportContext
      && !progressUpdate
      && !inboundFollowupAction
      && !concreteQuestion
      && baseState?.workState !== 'action_required'
      && !businessDocumentDelivery
      && !(baseState?.workState === 'reference' && promisedAttachmentMissing)
      && (inboundFulfillment || inboundAcknowledged)) {
    add(event('inbound_fulfillment_completed', 960, 0.95, {
      workState: 'completed',
      nextActor: 'none',
      priority: 'normal',
    }, inboundFulfillment || inboundAcknowledged));
  }

  const passivePayment = firstSubjectOrBodyClause(clauses, PASSIVE_PAYMENT_RECEIPT_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && passivePayment) {
    add(event('passive_payment_reference', 958, 0.98, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, passivePayment));
  }

  const passiveProcessCompletion = firstSubjectOrBodyClause(clauses, PASSIVE_PROCESS_COMPLETION_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && passiveProcessCompletion && automated) {
    add(event('automated_process_reference', 957, 0.97, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, passiveProcessCompletion));
  }

  const marketingUnsubscribe = firstSubjectOrBodyClause(clauses, MARKETING_UNSUBSCRIBE_PATTERN, {
    excludeBoilerplate: false,
  });
  if (marketingUnsubscribe && (message.isPromotional || automated)) {
    add(event('marketing_reference', 895, 0.98, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, marketingUnsubscribe));
  }

  const serviceContinuity = combinedEvidence(
    clauses,
    combined,
    SERVICE_CONTINUITY_ACTION_PATTERN,
    /(?:action\s+required|subscription|account|service|workspace|구독|계정|서비스|비활성화|해지|중지)/i,
    { excludeBoilerplate: true },
  );
  if (!outgoing && serviceContinuity && !MARKETING_UNSUBSCRIBE_PATTERN.test(combined)) {
    add(event('service_continuity_action', 890, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, serviceContinuity));
  }

  const cardLimit = combinedEvidence(
    clauses,
    combined,
    CARD_LIMIT_RISK_PATTERN,
    /(?:카드|credit\s*card|한도\s*(?:초과|소진)|선결제|결제\s*실패)/i,
    { excludeBoilerplate: true },
  );
  if (!outgoing && cardLimit) {
    add(event('financial_limit_risk_action', 885, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, cardLimit));
  }

  const subscriptionFollowup = combinedEvidence(
    clauses,
    combined,
    SUBSCRIPTION_FOLLOWUP_PATTERN,
    /(?:구독|subscription|심사|한도|신청|apply|activate)/i,
    { excludeBoilerplate: true },
  );
  if (!outgoing && subscriptionFollowup) {
    add(event('subscription_followup_action', 880, 0.94, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, subscriptionFollowup));
  }

  const sharedAccess = combinedEvidence(
    clauses,
    combined,
    SHARED_ACCESS_VERIFICATION_PATTERN,
    /(?:shared|공유|verify\s+your\s+email|이메일을?\s*인증)/i,
    { excludeBoilerplate: true },
  );
  if (!outgoing && sharedAccess) {
    add(event('shared_access_verification', 977, 0.96, {
      workState: 'action_required',
      nextActor: 'me',
      priority: 'normal',
    }, sharedAccess));
  }

  const processCompleted = firstClause(clauses, BUSINESS_PROCESS_COMPLETION_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && processCompleted && !supportContext) {
    add(event('business_process_completed', 970, 0.97, {
      workState: 'completed',
      nextActor: 'none',
      priority: 'normal',
    }, processCompleted));
  }

  const invoiceReady = firstSubjectOrBodyClause(clauses, INVOICE_READY_REFERENCE_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing
      && invoiceReady
      && INVOICE_PASSIVE_CONTEXT_PATTERN.test(combined)
      && (automated || isInvoiceFolder(message))) {
    add(event('automated_invoice_reference', 860, 0.97, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, invoiceReady));
  }

  const taxInvoiceNotice = firstSubjectOrBodyClause(clauses, TAX_INVOICE_NOTICE_PATTERN, {
    excludeBoilerplate: true,
  });
  const taxInvoiceDirection = taxInvoiceDirectionFromSubject(subject);
  const explicitlyIncomingTaxInvoice = taxInvoiceDirection === 'incoming'
    || /(?:귀사|your\s+company).{0,24}(?:에|to).{0,40}(?:전자)?세금계산서/i.test(combined);
  if (!outgoing && taxInvoiceNotice && isInvoiceFolder(message) && explicitlyIncomingTaxInvoice) {
    add(event('received_tax_invoice_review', 856, 0.94, {
      workState: 'review_required',
      nextActor: 'unknown',
      priority: 'normal',
    }, taxInvoiceNotice, { taxInvoiceDirection }));
  } else if (!outgoing && taxInvoiceNotice && isInvoiceFolder(message)) {
    add(event('archived_tax_invoice_reference', 855, 0.97, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, taxInvoiceNotice, { taxInvoiceDirection }));
  }

  if (!outgoing
      && BULK_SUBJECT_REQUEST_PATTERN.test(subject)
      && BULK_ROUTING_BODY_PATTERN.test(bodyText)
      && bodyText.length < 180) {
    add(event('bulk_subject_notice_reference', 850, 0.92, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, subjectEvidence(clauses)));
  }

  const passiveNotification = firstSubjectOrBodyClause(clauses, PASSIVE_NOTIFICATION_PATTERN, {
    excludeBoilerplate: true,
  });
  if (!outgoing && automated && passiveNotification) {
    add(event('automated_notification_reference', 500, 0.9, {
      workState: 'reference',
      nextActor: 'none',
      priority: 'low',
    }, passiveNotification));
  }

  if (outgoing) {
    const delivery = firstClause(clauses, OUTGOING_DELIVERY_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const recipientResponse = firstClause(clauses, RECIPIENT_RESPONSE_REQUEST_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const courtesyEvidence = firstClause(clauses, INFORMATIONAL_COURTESY_REVIEW_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const courtesyOnly = Boolean(courtesyEvidence);
    const conditionalOffer = firstClause(clauses, CONDITIONAL_FUTURE_OFFER_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const pastAction = firstClause(clauses, OUTGOING_PAST_ACTION_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const directRequest = firstClause(clauses, OUTGOING_REQUEST_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });
    const substantiveResponse = firstClause(clauses, OUTGOING_SUBSTANTIVE_RESPONSE_PATTERN, {
      bodyOnly: true,
      excludeBoilerplate: true,
    });

    const commercialQuoteDelivery = Boolean(message.hasAttachments)
      && /(?:견적(?:서)?|quotation|quote)/i.test(`${subject}\n${delivery?.text || ''}`)
      && Boolean(delivery)
      && Boolean(recipientResponse)
      && !/(?:\[\s*(?:긴급|urgent)\s*\]|\b(?:urgent|asap)\b|긴급)/i.test(subject)
      && !conditionalOffer
      && !OUTGOING_UNRESOLVED_COMMITMENT_PATTERN.test(combined);
    if (commercialQuoteDelivery) {
      add(event('outgoing_commercial_quote_delivery_waiting', 845, 0.96, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, recipientResponse));
    } else if (delivery && recipientResponse && !courtesyOnly && !conditionalOffer) {
      add(event('outgoing_delivery_waiting_for_recipient', 840, 0.94, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: 'normal',
      }, recipientResponse));
    } else if (substantiveResponse && !recipientResponse && !directRequest) {
      add(event('outgoing_substantive_response_completed', 835, 0.95, {
        workState: 'completed',
        nextActor: 'none',
        priority: 'normal',
      }, substantiveResponse));
    } else if ((delivery || pastAction) && (!directRequest || courtesyOnly || conditionalOffer)) {
      const responseCompleted = pastAction
        && /(?:답변|회신|answered|responded)/i.test(pastAction.text);
      add(event(responseCompleted ? 'outgoing_response_completed' : 'outgoing_delivery_completed', 830, 0.92, {
        workState: 'completed',
        nextActor: 'none',
        priority: null,
      }, pastAction || delivery));
    } else if (directRequest) {
      add(event('outgoing_request_waiting', 820, 0.94, {
        workState: 'waiting',
        nextActor: 'external_party',
        priority: null,
      }, directRequest));
    }
  }

  const currentUrgency = firstClause(clauses, CURRENT_URGENCY_PATTERN, {
    excludeBoilerplate: true,
  });
  if (currentUrgency
      && ['action_required', 'decision_required', 'waiting'].includes(baseState?.workState)) {
    const criticalIncident = /보안|security|침해|breach|malware|랜섬웨어/i.test(combined)
      && /장애|접속\s*불가|중단|incident|outage/i.test(combined)
      && /긴급|즉시|critical|immediately/i.test(combined);
    add(event('current_action_urgency', 100, 0.92, {
      workState: baseState.workState,
      nextActor: null,
      priority: criticalIncident ? 'critical' : 'high',
    }, currentUrgency));
  }

  const lifecycle = message.isDeletedFolder
    ? 'deleted'
    : message.isJunkFolder
      ? 'junk'
      : message.isDraft || message.isDraftFolder
        ? 'draft'
        : 'active';
  const reconciled = reconcileEvents(events, { lifecycle });

  return {
    version: MAIL_EVENT_FRAME_VERSION,
    direction: outgoing ? 'outgoing' : 'incoming',
    automated,
    lifecycle,
    events: reconciled.events,
    primaryEvent: reconciled.primaryEvent,
    conflicts: reconciled.conflicts,
    stateMachine: reconciled.stateMachine,
  };
}

const EVENT_RULE_NAMES = Object.freeze({
  empty_message_reference: 'empty-message-reference',
  empty_message_review: 'empty-message-review',
  delivery_failure_action: 'delivery-failure-action',
  procurement_deadline_action: 'procurement-deadline-action',
  active_component_incident: 'active-component-incident',
  document_package_urgent_action: 'document-package-urgent-action',
  editorial_guide_reference: 'editorial-guide-reference',
  active_incident_action: 'active-incident-action',
  support_handoff_action: 'support-handoff-action',
  support_remote_availability_action: 'support-remote-availability-action',
  incoming_collaboration_invite_action: 'incoming-collaboration-invite-action',
  support_acknowledged_waiting: 'support-acknowledged-waiting',
  support_pending_response: 'support-pending-response',
  support_remote_availability: 'support-remote-availability',
  support_provider_request_waiting: 'support-provider-request-waiting',
  support_incoming_request_action: 'support-incoming-request-action',
  support_close_approval: 'support-close-approval-required',
  support_resolved: 'support-ticket-completed',
  support_artifact_delivered: 'support-artifact-delivered',
  support_schedule_confirmed: 'support-schedule-confirmed',
  progress_update_review: 'progress-update-review',
  concrete_question_action: 'concrete-question-action',
  access_information_reference: 'access-information-reference',
  inbound_followup_action: 'inbound-followup-action',
  informational_asset_reference: 'informational-asset-reference',
  inbound_acknowledgement_completed: 'inbound-acknowledgement-completed',
  inbound_substantive_fulfillment_completed: 'inbound-substantive-fulfillment-completed',
  inbound_business_document_review: 'inbound-business-document-review',
  inbound_fulfillment_completed: 'inbound-fulfillment-completed',
  passive_payment_reference: 'passive-payment-reference',
  automated_process_reference: 'automated-process-reference',
  service_continuity_action: 'service-deactivation-action',
  financial_limit_risk_action: 'financial-limit-risk-action',
  subscription_followup_action: 'subscription-followup-action',
  shared_access_verification: 'shared-access-verification-action',
  business_process_completed: 'business-process-completed',
  automated_invoice_reference: 'automated-invoice-reference',
  received_tax_invoice_review: 'received-tax-invoice-review',
  archived_tax_invoice_reference: 'archived-tax-invoice-reference',
  bulk_subject_notice_reference: 'bulk-subject-notice-reference',
  automated_notification_reference: 'automated-notification-reference',
  marketing_reference: 'marketing-reference',
  outgoing_delivery_waiting_for_recipient: 'outgoing-request-awaiting-recipient',
  outgoing_commercial_quote_delivery_waiting: 'outgoing-commercial-quote-awaiting-recipient',
  outgoing_delivery_completed: 'outgoing-delivery-completed',
  outgoing_response_completed: 'outgoing-response-completed',
  outgoing_substantive_response_completed: 'outgoing-substantive-response-completed',
  outgoing_request_waiting: 'outgoing-request-awaiting-recipient',
  current_action_urgency: 'current-action-urgency',
  lifecycle_reference: 'lifecycle-reference',
});

export function decisionFromMailEventFrame(frame) {
  const primary = frame?.primaryEvent;
  if (!primary) return null;
  const urgency = frame.events?.find((candidate) => candidate.type === 'current_action_urgency'
    && candidate.decision.workState === primary.decision.workState);
  const priorityEvent = urgency || primary;
  return {
    workState: primary.decision.workState,
    stateConfidence: primary.confidence,
    stateEvidence: primary.evidence,
    stateRule: EVENT_RULE_NAMES[primary.type] || `event:${primary.type}`,
    reviewReasons: primary.decision.workState === 'review_required'
      ? [`event_review:${primary.type}`]
      : [],
    nextActorHint: primary.decision.nextActor,
    priorityHint: priorityEvent.decision.priority,
    priorityEvidenceHint: priorityEvent.evidence || primary.evidence,
    priorityRuleHint: EVENT_RULE_NAMES[priorityEvent.type] || `event:${priorityEvent.type}`,
    eventType: primary.type,
    eventVersion: frame.version,
    eventConflicts: frame.conflicts,
  };
}

export function isPriorityBoilerplate(value = '') {
  return LEGAL_OR_CONTACT_BOILERPLATE_PATTERN.test(String(value || ''));
}
