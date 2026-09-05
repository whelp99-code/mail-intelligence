const COMPLETION_PATTERN = /완료|해결|종료|정상화|조치\s*완료|completed|resolved|fixed|closed/i;
const PATCH_TICKET_PATTERN = /패치|patch|티켓|ticket|case|kernel/i;
const PATCH_PATTERN = /패치|patch|kernel/i;
const TICKET_PATTERN = /티켓|ticket|case/i;
const HCI_PATTERN = /\bhci\b|하이퍼컨버지드|가상화\s*클러스터/i;
const LICENSE_PATTERN = /라이선스|license|licence|subscription|구독/i;
const INCIDENT_PATTERN = /장애|오류|중단|접속\s*불가|비정상|실패|issue|incident|outage|error|failed|failure|unavailable/i;
const STRONG_SECURITY_PATTERN = /보안|security|침해|해킹|취약점|악성코드|랜섬웨어|breach|compromise|vulnerability|malware|ransomware|unauthorized|비정상\s*(?:로그인|접속)/i;
const VPN_PATTERN = /\bvpn\b/i;
const INVOICE_OR_INSURANCE_NOISE_PATTERN = /세금계산서|청구서|invoice|보험|insurance|증권|카드\s*명세|billing/i;
const SUPPORT_PATTERN = /지원|문의|support|ticket|case/i;
const SHARED_ASSET_PATTERN = /공유\s*(?:폴더|파일)|shared\s*(?:folder|file)/i;
const VERIFICATION_PATTERN = /이메일\s*인증|인증|email\s*verification|verify|verification/i;
const QUOTATION_PATTERN = /견적|quotation|quote/i;
const PURCHASE_ORDER_PATTERN = /발주|주문서|purchase\s*order|\bpo\b|order/i;
const PROGRESS_PATTERN = /진행|후속|상태\s*확인|progress|follow[- ]?up|status/i;
const INVOICE_PATTERN = /세금계산서|청구서|invoice|billing/i;
const HUMAN_REVIEW_PATTERN = /담당자|사람|수동|검토|확인\s*요청|승인|human|manual|review|approve|(?:분할\s*)?발행.{0,24}(?:부탁|요청|바랍니다)/i;
const AUTOMATION_NOTICE_PATTERN = /자동\s*(?:발행|생성|안내|알림)|자동화|system\s*(?:notice|notification)|automated?|no[- ]?reply/i;
const FOLLOW_UP_PATTERN = /확인\s*(?:요청|필요)|회신\s*(?:요청|필요)|승인\s*(?:요청|필요)|조치\s*(?:요청|필요)|follow[- ]?up|confirm(?:ation)?|reply\s*(?:requested|required)?|approval\s*(?:requested|required)?/i;
const EXTERNAL_PARTY_PATTERN = /고객|상대방|외부|벤더|공급사|partner|customer|client|vendor|external/i;

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function currentBodyText(message = {}) {
  const raw = message.bodyText || message.body || message.bodyPreview || '';
  return normalize(splitMessageHistory(raw).currentContent);
}
function resultParts(result = {}) {
  const message = result.message || result.mail || result;
  const classification = result.classification || result.precision || result.precisionClassification || {};
  const bodyText = currentBodyText(message);
  return { message, classification, candidateText: bodyText };
}

function queryIntent(query = '') {
  const normalized = normalize(query);
  const completedPatchTicket = COMPLETION_PATTERN.test(normalized) && PATCH_TICKET_PATTERN.test(normalized);
  const hciLicenseIncident = HCI_PATTERN.test(normalized) && LICENSE_PATTERN.test(normalized) && INCIDENT_PATTERN.test(normalized);
  const security = /^(?:보안|security|보안\s*(?:관련|문의|이슈)|security\s*(?:issue|incident))$/i.test(normalized);
  const completedSupport = COMPLETION_PATTERN.test(normalized) && SUPPORT_PATTERN.test(normalized);
  const sharedVerification = SHARED_ASSET_PATTERN.test(normalized) && VERIFICATION_PATTERN.test(normalized);
  const quotationOrderProgress = QUOTATION_PATTERN.test(normalized)
    && PURCHASE_ORDER_PATTERN.test(normalized)
    && PROGRESS_PATTERN.test(normalized);
  const invoiceHumanReview = INVOICE_PATTERN.test(normalized) && HUMAN_REVIEW_PATTERN.test(normalized);
  const completedHistoryFollowup = COMPLETION_PATTERN.test(normalized) && FOLLOW_UP_PATTERN.test(normalized);
  return {
    normalized,
    completedPatchTicket,
    completedSupport,
    hciLicenseIncident,
    security,
    sharedVerification,
    quotationOrderProgress,
    invoiceHumanReview,
    completedHistoryFollowup,
  };
}

function semanticScore(intent, result) {
  const { classification, candidateText } = resultParts(result);
  const workState = String(classification.workState || classification.work_state || '').toLowerCase();
  const signals = Array.isArray(classification.signals) ? classification.signals.join(' ') : '';
  let score = 0;
  let qualifies = true;
  const reasons = [];

  if (intent.completedPatchTicket) {
    const completed = workState === 'completed' || COMPLETION_PATTERN.test(candidateText);
    const patchTicket = PATCH_PATTERN.test(candidateText) && TICKET_PATTERN.test(candidateText);
    qualifies = completed && patchTicket;
    if (completed) { score += 6; reasons.push('completed'); }
    if (patchTicket) { score += 5; reasons.push('patch-ticket'); }
  }

  if (intent.completedSupport) {
    const completed = workState === 'completed' || COMPLETION_PATTERN.test(candidateText);
    const support = SUPPORT_PATTERN.test(candidateText);
    qualifies = qualifies && completed && support;
    if (completed) { score += 5; reasons.push('completed'); }
    if (support) { score += 4; reasons.push('support'); }
  }

  if (intent.hciLicenseIncident) {
    const hci = HCI_PATTERN.test(candidateText);
    const license = LICENSE_PATTERN.test(candidateText);
    const incident = INCIDENT_PATTERN.test(candidateText) || /incident_security/i.test(signals);
    qualifies = qualifies && hci && license && incident;
    if (hci) { score += 4; reasons.push('hci'); }
    if (license) { score += 4; reasons.push('license'); }
    if (incident) { score += 6; reasons.push('incident'); }
  }

  if (intent.security) {
    const strongSecurity = STRONG_SECURITY_PATTERN.test(candidateText) || /incident_security/i.test(signals);
    const contextualVpn = VPN_PATTERN.test(candidateText) && INCIDENT_PATTERN.test(candidateText);
    const noiseOnly = INVOICE_OR_INSURANCE_NOISE_PATTERN.test(candidateText) && !strongSecurity && !contextualVpn;
    const requestedSecurity = /보안|security/i.test(candidateText);
    qualifies = qualifies && (strongSecurity || contextualVpn) && !noiseOnly;
    if (strongSecurity) { score += 7; reasons.push('security-evidence'); }
    if (contextualVpn) { score += 4; reasons.push('vpn-incident'); }
    if (requestedSecurity) { score += 2; reasons.push('requested-security'); }
    if (noiseOnly) score -= 20;
  }

  if (intent.sharedVerification) {
    const sharedAsset = SHARED_ASSET_PATTERN.test(candidateText);
    const verification = VERIFICATION_PATTERN.test(candidateText);
    qualifies = qualifies && sharedAsset && verification;
    if (sharedAsset) { score += 4; reasons.push('shared-asset'); }
    if (verification) { score += 4; reasons.push('verification'); }
  }

  if (intent.quotationOrderProgress) {
    const quotation = QUOTATION_PATTERN.test(candidateText);
    const purchaseOrder = PURCHASE_ORDER_PATTERN.test(candidateText);
    const progress = PROGRESS_PATTERN.test(candidateText);
    qualifies = qualifies && quotation && purchaseOrder && progress;
    if (quotation) { score += 4; reasons.push('quotation'); }
    if (purchaseOrder) { score += 4; reasons.push('purchase-order'); }
    if (progress) { score += 3; reasons.push('progress'); }
  }

  if (intent.invoiceHumanReview) {
    const invoice = INVOICE_PATTERN.test(candidateText);
    const humanReview = HUMAN_REVIEW_PATTERN.test(candidateText);
    const automated = AUTOMATION_NOTICE_PATTERN.test(candidateText);
    qualifies = qualifies && invoice && humanReview && !automated;
    if (invoice) { score += 4; reasons.push('invoice'); }
    if (humanReview) { score += 4; reasons.push('human-review'); }
    if (automated) score -= 20;
  }

  if (intent.completedHistoryFollowup) {
    const completed = workState === 'completed' || COMPLETION_PATTERN.test(candidateText);
    const followup = FOLLOW_UP_PATTERN.test(candidateText);
    const external = String(classification.nextActor || classification.next_actor || '').toLowerCase() === 'external_party'
      || EXTERNAL_PARTY_PATTERN.test(candidateText);
    qualifies = qualifies && completed && followup && external;
    if (completed) { score += 4; reasons.push('completed-context'); }
    if (followup) { score += 4; reasons.push('current-follow-up'); }
    if (external) { score += 3; reasons.push('external-party'); }
  }

  if (workState === 'completed' && intent.completedPatchTicket) score += 3;
  if (['action_required', 'review_required'].includes(workState) && intent.hciLicenseIncident) score += 2;

  return { qualifies, score, reasons };
}

export function rerankSemanticSearchResults(query, results = []) {
  if (!Array.isArray(results) || results.length === 0) return results;
  const intent = queryIntent(query);
  if (!intent.completedPatchTicket
    && !intent.completedSupport
    && !intent.hciLicenseIncident
    && !intent.security
    && !intent.sharedVerification
    && !intent.quotationOrderProgress
    && !intent.invoiceHumanReview
    && !intent.completedHistoryFollowup) return results;

  const scored = results.map((result, index) => ({
    result,
    index,
    ...semanticScore(intent, result),
  }));
  const qualifying = scored.filter((item) => item.qualifies);
  if (qualifying.length === 0) return [];

  return qualifying
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => ({
      ...item.result,
      semanticRank: {
        score: item.score,
        reasons: item.reasons,
      },
    }));
}

export function evaluateSemanticSearchResults(query, results = []) {
  const intent = queryIntent(query);
  const evaluatedResults = intent.security ? results : rerankSemanticSearchResults(query, results);
  const answerable = evaluatedResults.length > 0;
  return {
    results: evaluatedResults,
    decision: {
      answerable,
      abstained: !answerable,
      reason: answerable ? 'direct_result' : 'no_safe_result',
    },
  };
}

export function semanticSearchIntent(query) {
  return queryIntent(query);
}
import { splitMessageHistory } from './precision-classifier.js';
