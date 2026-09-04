export const OPERATIONAL_CLASSIFICATION_VERSION = 'operational-classification-v1.2.2';

export const OPERATIONAL_LANES = Object.freeze([
  'do_now',
  'waiting',
  'review',
  'archive',
]);

const ACTIONABLE_STATES = new Set(['action_required', 'decision_required']);
const ARCHIVE_STATES = new Set(['completed', 'reference']);
const SAFE_WAITING_ACTORS = new Set(['external_party', 'internal_team', 'shared']);
const ACTION_EVENT_STATES = new Set(['action_required', 'decision_required', 'waiting']);
const ARCHIVE_BLOCKING_SIGNALS = new Set([
  'deadline',
  'schedule',
  'approval',
  'incident_security',
  'attachment_missing',
]);
const AMBIGUOUS_EVENT_TYPES = new Set([
  'incoming_business_document_review',
  'incoming_tax_invoice_review',
  'support_context_fallback',
  'incomplete_or_ambiguous_outgoing',
  'empty_message_review',
  'security_verification_alert',
]);
const NEW_BUSINESS_DOCUMENT_PATTERN = /(?:신규|new).{0,50}(?:세금계산서|invoice|견적서|quotation|계약서|contract|발주서|purchase\s*order)|(?:세금계산서|invoice|견적서|quotation|계약서|contract|발주서|purchase\s*order).{0,50}(?:도착|수신|received)/i;

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function boundedConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function eventDecision(event) {
  return event?.decision && typeof event.decision === 'object'
    ? event.decision
    : {};
}

function actionableEvents(eventFrame = {}) {
  return (eventFrame.events || []).filter((event) => {
    const decision = eventDecision(event);
    return ACTION_EVENT_STATES.has(decision.workState);
  });
}

function unresolvedEvents(eventFrame = {}) {
  return (eventFrame.events || []).filter((event) => {
    const decision = eventDecision(event);
    return decision.workState === 'review_required'
      || AMBIGUOUS_EVENT_TYPES.has(event.type);
  });
}

function baseLane(classification = {}) {
  if (ACTIONABLE_STATES.has(classification.workState)) return 'do_now';
  if (classification.workState === 'waiting') return 'waiting';
  if (classification.workState === 'review_required') return 'review';
  return 'archive';
}

function autoLabelFor(lane, classification = {}) {
  if (lane === 'do_now') return 'reply_needed';
  if (lane === 'waiting') return 'waiting';
  if (lane === 'review') return 'review';
  if (classification.workState === 'completed') return 'simple_update';
  return 'later';
}

export function deriveOperationalClassification(classification = {}, {
  message = {},
  eventFrame = {},
  meetingCandidate = null,
  attachmentCandidates = [],
} = {}) {
  const reasons = [];
  const riskSignals = [];
  const workStateConfidence = boundedConfidence(classification.confidence?.workState);
  const actorConfidence = boundedConfidence(classification.confidence?.nextActor);
  const priorityConfidence = boundedConfidence(classification.confidence?.priority);
  const base = baseLane(classification);
  const eventsWithAction = actionableEvents(eventFrame);
  const eventsUnresolved = unresolvedEvents(eventFrame);
  const stateConflicts = Array.isArray(eventFrame.conflicts) ? eventFrame.conflicts : [];
  const signals = new Set(classification.signals || []);
  const activeSignals = [...signals].filter((signal) => ARCHIVE_BLOCKING_SIGNALS.has(signal));
  const hasMeetingCandidate = Boolean(meetingCandidate?.detected || meetingCandidate?.meetingIntent);
  const hasAttachmentReview = (attachmentCandidates || []).some((item) => (
    item?.requiresReview === true
    || item?.summaryStatus === 'metadata_only'
    || item?.contentAvailable === false
  ));
  const draftLike = Boolean(message.isDraft || message.isDraftFolder);
  const lifecycleArchive = Boolean(message.isDeletedFolder || message.isJunkFolder);
  const classificationEvidenceText = Object.values(classification.evidence || {})
    .map((item) => item?.exactText || item?.text || '')
    .join('\n');
  const newBusinessDocument = signals.has('quotation_contract')
    && NEW_BUSINESS_DOCUMENT_PATTERN.test(`${message.subject || ''}\n${message.body || message.bodyPreview || ''}\n${classificationEvidenceText}`);
  const unresolvedAutomaticReviewReasons = classification.source !== 'user-corrected'
    && classification.reviewStatus === 'review_required'
    ? classification.reviewReasons || []
    : [];

  if (stateConflicts.length) {
    riskSignals.push('event_conflict');
    reasons.push('사건 후보가 서로 다른 업무 상태를 가리킵니다.');
  }
  if (unresolvedAutomaticReviewReasons.length) {
    riskSignals.push('classification_review_reason');
  }
  if (workStateConfidence < 0.82) {
    riskSignals.push('low_work_state_confidence');
    reasons.push('업무 상태 신뢰도가 자동 확정 기준보다 낮습니다.');
  }
  if (!ARCHIVE_STATES.has(classification.workState) && actorConfidence < 0.72) {
    riskSignals.push('low_actor_confidence');
    reasons.push('다음 행동 주체가 충분히 확정되지 않았습니다.');
  }
  if (eventsUnresolved.length) {
    riskSignals.push('unresolved_event');
    reasons.push('현재 본문에 해소되지 않은 사건 후보가 있습니다.');
  }
  if (hasMeetingCandidate) {
    riskSignals.push('meeting_candidate');
    reasons.push('미팅 의도 또는 일정 후보가 있어 확인이 필요합니다.');
  }
  if (hasAttachmentReview) {
    riskSignals.push('attachment_review');
    reasons.push('첨부 내용이 자동 확인되지 않아 원문 검토가 필요합니다.');
  }
  if (newBusinessDocument) {
    riskSignals.push('new_business_document');
    reasons.push('신규 업무 문서 도착 여부를 사람이 확인해야 합니다.');
  }
  if (activeSignals.length) {
    riskSignals.push(...activeSignals.map((signal) => `signal:${signal}`));
  }
  if (classification.dueAt || classification.dueText) {
    riskSignals.push('due_present');
  }
  if (draftLike && !lifecycleArchive) {
    riskSignals.push('draft_not_sent');
  }

  let lane = base;
  let archiveEligible = base === 'archive';

  if (base === 'archive') {
    const archiveBlockers = [];
    if (!ARCHIVE_STATES.has(classification.workState)) archiveBlockers.push('not_archive_state');
    if (workStateConfidence < 0.9) archiveBlockers.push('archive_confidence_below_90');
    if (classification.nextActor !== 'none') archiveBlockers.push('archive_actor_not_none');
    if (eventsWithAction.length) archiveBlockers.push('actionable_event_present');
    if (eventsUnresolved.length) archiveBlockers.push('unresolved_event_present');
    if (stateConflicts.length) archiveBlockers.push('event_conflict_present');
    if (unresolvedAutomaticReviewReasons.length) archiveBlockers.push('classification_review_reason_present');
    if (activeSignals.length) archiveBlockers.push('active_signal_present');
    if (classification.dueAt || classification.dueText) archiveBlockers.push('due_present');
    if (hasMeetingCandidate) archiveBlockers.push('meeting_candidate_present');
    if (hasAttachmentReview) archiveBlockers.push('attachment_review_present');
    if (newBusinessDocument) archiveBlockers.push('new_business_document_present');
    if (draftLike && !lifecycleArchive) archiveBlockers.push('draft_present');
    archiveEligible = archiveBlockers.length === 0;
    if (!archiveEligible) {
      lane = 'review';
      riskSignals.push(...archiveBlockers);
      reasons.push('조용한 업무 누락을 막기 위해 자동 보관을 차단했습니다.');
    }
  }

  if (base === 'do_now') {
    if (classification.nextActor === 'unknown' || workStateConfidence < 0.72 || actorConfidence < 0.72 || stateConflicts.length) {
      lane = 'review';
      reasons.push('행동 필요 후보지만 상태 또는 담당자 충돌이 있어 검토로 보냅니다.');
    }
  }

  if (base === 'waiting') {
    if (!SAFE_WAITING_ACTORS.has(classification.nextActor) || workStateConfidence < 0.72 || actorConfidence < 0.72 || stateConflicts.length) {
      lane = 'review';
      reasons.push('대기 후보지만 다음 행동 주체가 안정적으로 확정되지 않았습니다.');
    }
  }

  if (classification.workState === 'review_required') lane = 'review';

  const requiresHumanReview = lane === 'review';
  const autoConfirmed = !requiresHumanReview
    && (lane !== 'archive' || archiveEligible)
    && workStateConfidence >= 0.82
    && (classification.nextActor === 'none' || actorConfidence >= 0.72);

  return {
    version: OPERATIONAL_CLASSIFICATION_VERSION,
    lane,
    label: {
      do_now: 'DO NOW',
      waiting: 'WAITING',
      review: 'REVIEW',
      archive: 'ARCHIVE',
    }[lane],
    autoLabel: autoLabelFor(lane, classification),
    baseLane: base,
    archiveEligible,
    requiresHumanReview,
    autoConfirmed,
    silentRiskPrevented: base === 'archive' && lane === 'review',
    riskSignals: unique(riskSignals),
    reasons: unique(reasons),
    confidenceBand: workStateConfidence >= 0.9 && actorConfidence >= 0.9
      ? 'high'
      : workStateConfidence >= 0.72 && (classification.nextActor === 'none' || actorConfidence >= 0.72)
        ? 'medium'
        : 'low',
    confidence: {
      workState: workStateConfidence,
      nextActor: actorConfidence,
      priority: priorityConfidence,
    },
  };
}

export function operationalSummary(classifications = []) {
  const lanes = Object.fromEntries(OPERATIONAL_LANES.map((lane) => [lane, 0]));
  let silentRiskPrevented = 0;
  let autoConfirmed = 0;
  let reviewCoverage = 0;
  let correctionCount = 0;

  for (const classification of classifications) {
    const operational = classification?.operational || deriveOperationalClassification(classification);
    if (Object.hasOwn(lanes, operational.lane)) lanes[operational.lane] += 1;
    if (operational.silentRiskPrevented) silentRiskPrevented += 1;
    if (operational.autoConfirmed) autoConfirmed += 1;
    if (operational.requiresHumanReview) reviewCoverage += 1;
    if (classification?.reviewStatus === 'corrected' || classification?.source === 'user-corrected') correctionCount += 1;
  }

  return {
    version: OPERATIONAL_CLASSIFICATION_VERSION,
    total: classifications.length,
    lanes,
    silentRiskPrevented,
    autoConfirmed,
    reviewCoverage,
    correctionCount,
    autoConfirmedRate: classifications.length ? autoConfirmed / classifications.length : 0,
    reviewRate: classifications.length ? reviewCoverage / classifications.length : 0,
  };
}

export const operationalClassificationInternals = {
  ACTIONABLE_STATES,
  ARCHIVE_STATES,
  ARCHIVE_BLOCKING_SIGNALS,
  SAFE_WAITING_ACTORS,
  actionableEvents,
  baseLane,
  unresolvedEvents,
};
