const COMPLETION_PATTERN = /완료|해결|종료|정상화|조치\s*완료|completed|resolved|fixed|closed/i;
const PATCH_TICKET_PATTERN = /패치|patch|티켓|ticket|case|kernel/i;
const HCI_PATTERN = /\bhci\b|하이퍼컨버지드|가상화\s*클러스터/i;
const LICENSE_PATTERN = /라이선스|license|licence|subscription|구독/i;
const INCIDENT_PATTERN = /장애|오류|중단|접속\s*불가|비정상|실패|issue|incident|outage|error|failed|failure|unavailable/i;
const STRONG_SECURITY_PATTERN = /보안|security|침해|해킹|취약점|악성코드|랜섬웨어|breach|compromise|vulnerability|malware|ransomware|unauthorized|비정상\s*(?:로그인|접속)/i;
const VPN_PATTERN = /\bvpn\b/i;
const INVOICE_OR_INSURANCE_NOISE_PATTERN = /세금계산서|청구서|invoice|보험|insurance|증권|카드\s*명세|billing/i;

function normalize(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function resultParts(result = {}) {
  const message = result.message || result.mail || result;
  const classification = result.classification || result.precision || result.precisionClassification || {};
  const evidence = classification.evidence || result.evidence || {};
  const evidenceText = Object.values(evidence)
    .filter(Boolean)
    .map((item) => item.exactText || item.text || '')
    .join(' ');
  const text = normalize([
    message.subject,
    message.body,
    message.bodyText,
    message.bodyPreview,
    evidenceText,
  ].filter(Boolean).join(' '));
  return { message, classification, text };
}

function queryIntent(query = '') {
  const normalized = normalize(query);
  const completedPatchTicket = COMPLETION_PATTERN.test(normalized) && PATCH_TICKET_PATTERN.test(normalized);
  const hciLicenseIncident = HCI_PATTERN.test(normalized) && LICENSE_PATTERN.test(normalized) && INCIDENT_PATTERN.test(normalized);
  const security = /^(?:보안|security|보안\s*(?:관련|문의|이슈)|security\s*(?:issue|incident))$/i.test(normalized);
  return { normalized, completedPatchTicket, hciLicenseIncident, security };
}

function semanticScore(intent, result) {
  const { classification, text } = resultParts(result);
  const workState = String(classification.workState || classification.work_state || '').toLowerCase();
  const signals = Array.isArray(classification.signals) ? classification.signals.join(' ') : '';
  let score = 0;
  let qualifies = true;
  const reasons = [];

  if (intent.completedPatchTicket) {
    const completed = workState === 'completed' || COMPLETION_PATTERN.test(text);
    const patchTicket = PATCH_TICKET_PATTERN.test(text);
    qualifies = completed && patchTicket;
    if (completed) { score += 6; reasons.push('completed'); }
    if (patchTicket) { score += 5; reasons.push('patch-ticket'); }
  }

  if (intent.hciLicenseIncident) {
    const hci = HCI_PATTERN.test(text);
    const license = LICENSE_PATTERN.test(text);
    const incident = INCIDENT_PATTERN.test(text) || /incident_security/i.test(signals);
    qualifies = qualifies && hci && license && incident;
    if (hci) { score += 4; reasons.push('hci'); }
    if (license) { score += 4; reasons.push('license'); }
    if (incident) { score += 6; reasons.push('incident'); }
  }

  if (intent.security) {
    const strongSecurity = STRONG_SECURITY_PATTERN.test(text) || /incident_security/i.test(signals);
    const contextualVpn = VPN_PATTERN.test(text) && INCIDENT_PATTERN.test(text);
    const noiseOnly = INVOICE_OR_INSURANCE_NOISE_PATTERN.test(text) && !strongSecurity && !contextualVpn;
    qualifies = qualifies && (strongSecurity || contextualVpn) && !noiseOnly;
    if (strongSecurity) { score += 7; reasons.push('security-evidence'); }
    if (contextualVpn) { score += 4; reasons.push('vpn-incident'); }
    if (noiseOnly) score -= 20;
  }

  if (workState === 'completed' && intent.completedPatchTicket) score += 3;
  if (['action_required', 'review_required'].includes(workState) && intent.hciLicenseIncident) score += 2;

  return { qualifies, score, reasons };
}

export function rerankSemanticSearchResults(query, results = []) {
  if (!Array.isArray(results) || results.length === 0) return results;
  const intent = queryIntent(query);
  if (!intent.completedPatchTicket && !intent.hciLicenseIncident && !intent.security) return results;

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

export function semanticSearchIntent(query) {
  return queryIntent(query);
}
