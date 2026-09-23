import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SEND_DIGEST_WORKLINK_EXTENSION,
  WORK_LINK_EVENT_TYPES,
  assertDistinctActionBoundaries,
  createLinkDecisionEvent,
  sendDigestHasWorkLinkBinding,
  shouldBlockSendForLinkDrift,
} from '../src/domain/work-link-events.js';

const contracts = await readFile(new URL('../docs/planning/notion-crm-collaboration-v1/01-CONTRACTS.md', import.meta.url), 'utf8');

test('link confirm, activity post, and customer send are distinct events', () => {
  assert.notEqual(WORK_LINK_EVENT_TYPES.LINK_CONFIRM, WORK_LINK_EVENT_TYPES.ACTIVITY_POST);
  assert.notEqual(WORK_LINK_EVENT_TYPES.LINK_CONFIRM, WORK_LINK_EVENT_TYPES.CUSTOMER_SEND);
  assert.notEqual(WORK_LINK_EVENT_TYPES.ACTIVITY_POST, WORK_LINK_EVENT_TYPES.CUSTOMER_SEND);
  assert.equal(assertDistinctActionBoundaries(WORK_LINK_EVENT_TYPES.ACTIVITY_POST).confirmsProjectLink, false);
  assert.equal(assertDistinctActionBoundaries(WORK_LINK_EVENT_TYPES.LINK_CONFIRM).opensCustomerSend, false);
  assert.equal(assertDistinctActionBoundaries(WORK_LINK_EVENT_TYPES.CUSTOMER_SEND).confirmsProjectLink, false);

  const event = createLinkDecisionEvent({
    type: WORK_LINK_EVENT_TYPES.LINK_CORRECT,
    workLinkId: 'wl-1',
    revision: 'rev-1',
    actor: 'user:jae',
    correction: { externalId: 'syn-project-b' },
  });
  assert.equal(event.type, 'WorkLinkCorrected');
  assert.throws(
    () => createLinkDecisionEvent({ type: WORK_LINK_EVENT_TYPES.CUSTOMER_SEND, workLinkId: 'wl-1', revision: 'rev-1', actor: 'user:jae' }),
    { code: 'WORK_LINK_EVENT_TYPE_INVALID' },
  );
});

test('send approval digest must bind WorkLink and Commitment revisions', () => {
  assert.match(contracts, /workLinkRevision|WorkLink 개정/);
  assert.match(contracts, /customerExternalId|다른 고객/);
  assert.equal(sendDigestHasWorkLinkBinding({}), false);
  const bound = {
    workLinkId: 'wl-1',
    workLinkRevision: 'rev-1',
    commitmentId: 'c-1',
    commitmentRevision: 'crev-1',
    externalId: 'syn-project-a',
    customerExternalId: 'syn-account-sunjin',
  };
  assert.equal(sendDigestHasWorkLinkBinding(bound), true);
  assert.equal(shouldBlockSendForLinkDrift(bound, { ...bound, customerExternalId: 'syn-account-other' }), true);
  assert.equal(shouldBlockSendForLinkDrift(bound, bound), false);
  assert.ok(SEND_DIGEST_WORKLINK_EXTENSION.recheckAt.includes('approve'));
  assert.ok(SEND_DIGEST_WORKLINK_EXTENSION.recheckAt.includes('execute'));
});
