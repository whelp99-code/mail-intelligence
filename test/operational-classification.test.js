import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveOperationalClassification,
  operationalSummary,
} from '../src/domain/operational-classification.js';

function classification(overrides = {}) {
  return {
    workState: 'reference',
    nextActor: 'none',
    priority: 'low',
    dueText: '',
    dueAt: null,
    signals: [],
    reviewReasons: [],
    reviewStatus: 'auto',
    source: 'rules',
    confidence: {
      workState: 0.96,
      nextActor: 0.96,
      priority: 0.9,
    },
    ...overrides,
  };
}

test('high-confidence reference without risk can enter ARCHIVE', () => {
  const result = deriveOperationalClassification(classification());
  assert.equal(result.lane, 'archive');
  assert.equal(result.archiveEligible, true);
  assert.equal(result.autoLabel, 'later');
  assert.equal(result.requiresHumanReview, false);
});

test('actionable event prevents silent archive and routes to REVIEW', () => {
  const result = deriveOperationalClassification(classification(), {
    eventFrame: {
      events: [{
        type: 'incoming_direct_request',
        decision: { workState: 'action_required', nextActor: 'me' },
      }],
      conflicts: [],
    },
  });
  assert.equal(result.lane, 'review');
  assert.equal(result.archiveEligible, false);
  assert.equal(result.silentRiskPrevented, true);
  assert.ok(result.riskSignals.includes('actionable_event_present'));
});

test('low-confidence completed message cannot be silently archived', () => {
  const result = deriveOperationalClassification(classification({
    workState: 'completed',
    priority: 'normal',
    confidence: { workState: 0.74, nextActor: 0.95, priority: 0.8 },
  }));
  assert.equal(result.lane, 'review');
  assert.equal(result.silentRiskPrevented, true);
});

test('known action with ME becomes DO NOW', () => {
  const result = deriveOperationalClassification(classification({
    workState: 'action_required',
    nextActor: 'me',
    priority: 'normal',
    confidence: { workState: 0.9, nextActor: 0.9, priority: 0.8 },
  }));
  assert.equal(result.lane, 'do_now');
  assert.equal(result.autoLabel, 'reply_needed');
});

test('waiting with external actor becomes WAITING', () => {
  const result = deriveOperationalClassification(classification({
    workState: 'waiting',
    nextActor: 'external_party',
    priority: 'normal',
    confidence: { workState: 0.88, nextActor: 0.9, priority: 0.8 },
  }));
  assert.equal(result.lane, 'waiting');
});

test('unknown action actor is routed to REVIEW', () => {
  const result = deriveOperationalClassification(classification({
    workState: 'action_required',
    nextActor: 'unknown',
    priority: 'normal',
    confidence: { workState: 0.86, nextActor: 0.4, priority: 0.8 },
  }));
  assert.equal(result.lane, 'review');
  assert.equal(result.requiresHumanReview, true);
});

test('meeting and attachment uncertainty block archive', () => {
  const result = deriveOperationalClassification(classification(), {
    meetingCandidate: { detected: true },
    attachmentCandidates: [{ contentAvailable: false, summaryStatus: 'metadata_only' }],
  });
  assert.equal(result.lane, 'review');
  assert.ok(result.riskSignals.includes('meeting_candidate'));
  assert.ok(result.riskSignals.includes('attachment_review'));
});

test('operational summary counts lanes and corrected projections', () => {
  const values = [
    classification({ operational: { lane: 'archive', silentRiskPrevented: false, autoConfirmed: true, requiresHumanReview: false } }),
    classification({ workState: 'action_required', nextActor: 'me', operational: { lane: 'do_now', silentRiskPrevented: false, autoConfirmed: true, requiresHumanReview: false } }),
    classification({ workState: 'review_required', nextActor: 'unknown', operational: { lane: 'review', silentRiskPrevented: true, autoConfirmed: false, requiresHumanReview: true }, reviewStatus: 'corrected', source: 'user-corrected' }),
  ];
  const summary = operationalSummary(values);
  assert.deepEqual(summary.lanes, { do_now: 1, waiting: 0, review: 1, archive: 1 });
  assert.equal(summary.silentRiskPrevented, 1);
  assert.equal(summary.correctionCount, 1);
});
