export const WORK_LINK_EVENT_TYPES = Object.freeze({
  LINK_CONFIRM: 'WorkLinkConfirmed',
  LINK_REJECT: 'WorkLinkRejected',
  LINK_CORRECT: 'WorkLinkCorrected',
  ACTIVITY_POST: 'ActivityPosted',
  CUSTOMER_SEND: 'CustomerSendExecuted',
});

export const WORK_LINK_EVENT_PHASE = Object.freeze({
  LINK_DECISION: 'phase-4-event-contract',
  LEARNING: 'phase-5-learning-model',
});

export function assertDistinctActionBoundaries(eventType) {
  if (eventType === WORK_LINK_EVENT_TYPES.ACTIVITY_POST) {
    return { opensCustomerSend: false, confirmsProjectLink: false };
  }
  if (eventType === WORK_LINK_EVENT_TYPES.LINK_CONFIRM) {
    return { opensCustomerSend: false, postsActivity: false };
  }
  if (eventType === WORK_LINK_EVENT_TYPES.CUSTOMER_SEND) {
    return { confirmsProjectLink: false, postsActivity: false };
  }
  return { ok: true };
}

export function createLinkDecisionEvent({
  type,
  workLinkId,
  revision,
  actor,
  reason = '',
  correction = null,
} = {}) {
  const allowed = new Set([
    WORK_LINK_EVENT_TYPES.LINK_CONFIRM,
    WORK_LINK_EVENT_TYPES.LINK_REJECT,
    WORK_LINK_EVENT_TYPES.LINK_CORRECT,
  ]);
  if (!allowed.has(type)) {
    throw Object.assign(new Error('Not a WorkLink decision event.'), { code: 'WORK_LINK_EVENT_TYPE_INVALID' });
  }
  if (!workLinkId || !revision || !actor) {
    throw Object.assign(new Error('workLinkId, revision, and actor are required.'), { code: 'WORK_LINK_EVENT_INCOMPLETE' });
  }
  return {
    type,
    workLinkId,
    revision,
    actor,
    reason,
    correction,
    phase: WORK_LINK_EVENT_PHASE.LINK_DECISION,
    createdAt: new Date().toISOString(),
  };
}

export const SEND_DIGEST_WORKLINK_EXTENSION = Object.freeze({
  requiredAtDraftCreate: [
    'workLinkId',
    'workLinkRevision',
    'commitmentId',
    'commitmentRevision',
    'externalId',
    'customerExternalId',
  ],
  recheckAt: Object.freeze(['approve', 'execute']),
  blockIf: 'work_link_customer_changed',
  note: 'Existing mail-send-drafts payload_digest does not include WorkLink/Commitment revision. Phase 4 must bind the snapshot at draft create and refuse execute when the link moved to another customer.',
});

export function sendDigestHasWorkLinkBinding(digest = {}) {
  return SEND_DIGEST_WORKLINK_EXTENSION.requiredAtDraftCreate.every((field) => digest[field]);
}

export function shouldBlockSendForLinkDrift(bound, current) {
  if (!bound?.customerExternalId || !current?.customerExternalId) return true;
  return bound.customerExternalId !== current.customerExternalId
    || bound.workLinkId !== current.workLinkId
    || bound.workLinkRevision !== current.workLinkRevision;
}
