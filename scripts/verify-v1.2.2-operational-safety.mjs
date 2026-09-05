#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { attachmentSummaryCandidate, generateSafeDraft } from '../src/domain/mail-assistant-tools.js';
import { deriveOperationalClassification } from '../src/domain/operational-classification.js';
import { classifyMessage, PRECISION_CLASSIFICATION_VERSION } from '../src/domain/precision-classifier.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { INTELLIGENT_SEARCH_VERSION } from '../src/domain/intelligent-search.js';
import { BLIND_ACCEPTANCE_RUBRIC_VERSION, CLASSIFICATION_POLICY_VERSION } from '../src/version.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.version, '1.2.2');
assert.equal(PRECISION_CLASSIFICATION_VERSION, 'precision-classification-v1.2.2-fix11');
assert.equal(INTELLIGENT_SEARCH_VERSION, 'intelligent-search-v1.2.2-fix12');
assert.equal(CLASSIFICATION_POLICY_VERSION, 'classification-policy-v1.2.2-o01-o06');
assert.equal(BLIND_ACCEPTANCE_RUBRIC_VERSION, 'blind-acceptance-rubric-v2');

function message(id, subject, body, overrides = {}) {
  return normalizeGraphMessage({
    id,
    changeKey: `${id}-change`,
    conversationId: `${id}-thread`,
    subject,
    from: { emailAddress: { address: overrides.from || 'partner@example.com', name: 'Partner' } },
    toRecipients: [{ emailAddress: { address: 'jm@example.com', name: 'JM' } }],
    receivedDateTime: '2026-09-03T00:00:00Z',
    sentDateTime: '2026-09-03T00:00:00Z',
    createdDateTime: '2026-09-03T00:00:00Z',
    lastModifiedDateTime: '2026-09-03T00:00:00Z',
    importance: 'normal',
    isRead: false,
    isDraft: false,
    hasAttachments: false,
    bodyPreview: body,
    body: { contentType: 'text', content: body },
    parentFolderId: 'inbox',
    ...overrides.raw,
  });
}

const directAction = classifyMessage(
  message('direct-action', '견적 검토 요청', '내일까지 견적서를 검토하고 회신해 주세요.'),
  { mailboxAddress: 'jm@example.com' },
);
assert.equal(directAction.operational.lane, 'do_now');

const externalWaiting = classifyMessage(
  message('external-waiting', '[Ticket #12345] 지원 일정', '내일 오전 11시에 지원 세션을 진행하겠습니다.'),
  { mailboxAddress: 'jm@example.com' },
);
assert.equal(externalWaiting.operational.lane, 'waiting');

const newsletter = classifyMessage(
  message('newsletter', '월간 뉴스레터', '이번 달 주요 소식입니다. 수신거부 unsubscribe'),
  { mailboxAddress: 'jm@example.com' },
);
assert.equal(newsletter.operational.lane, 'archive');

const newInvoice = classifyMessage(
  message('new-invoice', '신규 전자세금계산서 도착', '신규 전자세금계산서가 도착했습니다. 내용을 확인해 주세요.'),
  { mailboxAddress: 'jm@example.com' },
);
assert.equal(newInvoice.operational.lane, 'review');
assert.equal(newInvoice.operational.silentRiskPrevented, true);

const archiveBlocked = deriveOperationalClassification({
  workState: 'reference',
  nextActor: 'none',
  priority: 'normal',
  dueText: '',
  dueAt: null,
  signals: [],
  reviewReasons: [],
  confidence: { workState: 0.96, nextActor: 0.96, priority: 0.8 },
}, {
  eventFrame: {
    events: [{ type: 'incoming_direct_request', decision: { workState: 'action_required', nextActor: 'me' } }],
    conflicts: [],
  },
});
assert.equal(archiveBlocked.lane, 'review');
assert.equal(archiveBlocked.silentRiskPrevented, true);

const draft = generateSafeDraft({
  message: message('draft', '기술 문의', '설정 방법을 알려 주세요.'),
  classification: directAction,
  mode: 'rapid_reply',
});
assert.equal(draft.sendAllowed, false);
assert.equal(draft.requiresHumanApproval, true);
assert.equal(draft.calendarWriteAllowed, false);
assert.equal(draft.crmWriteAllowed, false);
assert.equal(draft.action, 'copy_only');

const attachment = attachmentSummaryCandidate({
  name: 'proposal.pdf',
  contentType: 'application/pdf',
  size: 1024,
});
assert.equal(attachment.summaryStatus, 'metadata_only');
assert.equal(attachment.contentAvailable, false);
assert.equal(attachment.affectsClassification, false);
assert.equal(attachment.externalAiUsed, false);

const forbiddenMutations = [
  'MAIL_INTELLIGENCE_ACTIONS_APPROVED',
  'MAIL_INTELLIGENCE_ALLOW_SEND',
  'MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS',
  'MAIL_INTELLIGENCE_ALLOW_DATA_PLANE',
];
for (const key of forbiddenMutations) {
  assert.notEqual(process.env[key], '1', `${key} must not be enabled during v1.2.2 verification.`);
}

console.log(JSON.stringify({
  operationalSafety: 'PASS',
  packageVersion: packageJson.version,
  classifierVersion: PRECISION_CLASSIFICATION_VERSION,
  searchVersion: INTELLIGENT_SEARCH_VERSION,
  classificationPolicyVersion: CLASSIFICATION_POLICY_VERSION,
  blindAcceptanceRubricVersion: BLIND_ACCEPTANCE_RUBRIC_VERSION,
  lanes: {
    directAction: directAction.operational.lane,
    externalWaiting: externalWaiting.operational.lane,
    newsletter: newsletter.operational.lane,
    newInvoice: newInvoice.operational.lane,
  },
  silentActionMissGuard: 'PASS',
  draftCopyOnly: 'PASS',
  attachmentNoContentFabrication: 'PASS',
  calendarWriteAllowed: false,
  crmWriteAllowed: false,
  sendAllowed: false,
}, null, 2));
