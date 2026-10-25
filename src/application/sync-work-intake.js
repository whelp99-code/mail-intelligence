import { CwosWorkSystemAdapter } from '../adapters/cwos-work-system.js';
import { createIntakeAuthorization } from './intake-authorization.js';
import { MailWorkIntakeService } from './mail-work-intake.js';
import { mailSourceDigest } from '../adapters/cwos-mail-command.js';
import { enqueueMailCompanyMemoryOutbox } from './company-memory-donor.js';
import { hasCurrentBusinessRequest } from '../domain/precision-classifier.js';

function failure(error, fallbackCode) {
  return {
    code: error?.code || fallbackCode,
    message: String(error?.message || fallbackCode).slice(0, 200),
  };
}

function beginCandidateDispatch(store, entityId, payload) {
  // A surrounding transaction could roll back after the remote effect.
  if (store.txDepth) throw Object.assign(new Error('CWOS_CANDIDATE_TRANSACTION_OPEN'), {
    code: 'CWOS_CANDIDATE_TRANSACTION_OPEN',
  });
  return store.transaction(() => {
    // Use insertion order, not wall-clock time, for this durable state machine.
    const latest = store.db.prepare(`
      SELECT event_type FROM audit_events
      WHERE entity_type = 'crm_candidate_dispatch' AND entity_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(entityId);
    if (latest && latest.event_type !== 'mail.crm_candidate.dispatch_settled') {
      throw Object.assign(new Error('CWOS_CANDIDATE_OUTCOME_UNKNOWN'), {
        code: 'CWOS_CANDIDATE_OUTCOME_UNKNOWN',
      });
    }
    return store.audit('mail.crm_candidate.dispatch_started', {
      entityType: 'crm_candidate_dispatch', entityId, payload,
    }).id;
  });
}

function settleCandidateDispatch(store, entityId, attemptId, outcome) {
  store.audit('mail.crm_candidate.dispatch_settled', {
    entityType: 'crm_candidate_dispatch', entityId, payload: { attemptId, outcome },
  });
}

function readProviderIdentity(authorization) {
  if (typeof authorization?.identityProvenance !== 'function') return null;
  const identity = authorization.identityProvenance();
  const mailboxUser = String(identity?.mailboxUser || '').trim();
  const tenantId = String(identity?.tenantId || '').trim();
  const principalId = String(identity?.principalId || '').trim();
  if (!mailboxUser || !tenantId || !principalId || identity.provider !== 'microsoft-graph') {
    throw Object.assign(new Error('INTAKE_IDENTITY_UNPROVEN'), { code: 'INTAKE_IDENTITY_UNPROVEN', statusCode: 403 });
  }
  return { provider: 'microsoft-graph', mailboxUser, tenantId, principalId };
}

function uniqueMessageIds(messageIds = []) {
  const seen = new Set();
  const unique = [];
  for (const messageId of messageIds) {
    if (typeof messageId !== 'string' || !messageId.trim() || seen.has(messageId)) continue;
    seen.add(messageId);
    unique.push(messageId);
  }
  return unique;
}

export function createProductionIntakeBinding({
  db,
  mailboxUser = 'me',
  workspaceId = '',
  readMasters = null,
  authorization = null,
  candidateWriter = null,
  companyMemory = null,
} = {}) {
  if (!db) throw Object.assign(new Error('INTAKE_BINDING_REQUIRED'), { code: 'INTAKE_BINDING_REQUIRED' });
  const resolvedAuthorization = authorization || createIntakeAuthorization([{
    mailboxUser: mailboxUser || 'me',
    workspaceId,
  }]);
  const workSystem = new CwosWorkSystemAdapter({
    db,
    cwosClient: typeof readMasters === 'function' ? { readMasters } : null,
  });
  return { authorization: resolvedAuthorization, workSystem, candidateWriter, companyMemory };
}

export async function ingestAfterCommittedSync({
  store,
  workSystem,
  authorization,
  mailboxUser = '',
  workspaceId = '',
  messageIds = [],
  candidateWriter = null,
  companyMemory = null,
} = {}) {
  if (!store || !workSystem || typeof authorization?.authorize !== 'function') {
    throw Object.assign(new Error('INTAKE_BINDING_REQUIRED'), { code: 'INTAKE_BINDING_REQUIRED' });
  }
  const scope = authorization.authorize({ mailboxUser, workspaceId });
  const providerIdentity = readProviderIdentity(authorization);
  const captured = typeof authorization.capture === 'function' ? authorization.capture() : null;
  const assertBinding = typeof authorization.assertCurrent === 'function'
    ? () => authorization.assertCurrent(captured)
    : null;
  const ids = uniqueMessageIds(messageIds);
  const intake = new MailWorkIntakeService({ store, workSystem });
  let readResult = null;
  let masterFailure = null;
  if (scope.workspaceId && ids.length) {
    try {
      const result = await workSystem.readMasters({ workspaceId: scope.workspaceId });
      if (assertBinding) assertBinding();
      if (result?.nextCursor) {
        masterFailure = { code: 'CWOS_MASTERS_INCOMPLETE', message: 'CWOS_MASTERS_INCOMPLETE' };
      } else if (!result || !Array.isArray(result.items)) {
        masterFailure = { code: 'CWOS_MASTER_INVALID', message: 'CWOS_MASTER_INVALID' };
      } else {
        readResult = result;
      }
    } catch (error) {
      masterFailure = failure(error, 'CWOS_CLIENT_UNAVAILABLE');
    }
  }

  const failures = masterFailure ? [{ messageId: '', ...masterFailure }] : [];
  const skipped = [];
  const candidateSkipped = [];
  const acceptedMessageIds = [];
  let candidateVersion = readResult?.provenance?.runtimeVersion;
  const deliveredCandidates = [];
  let candidateFailure = null;
  if (masterFailure?.code !== 'INTAKE_BINDING_STALE') for (const messageId of ids) {
    try {
      const projection = await intake.ingest(scope.mailboxUser, messageId, masterFailure
        ? { assertBinding, providerIdentity }
        : { workspaceId: scope.workspaceId, readResult, assertBinding, providerIdentity });
      acceptedMessageIds.push(projection.messageId);
      const classification = projection.work?.classification;
      const businessRequest = hasCurrentBusinessRequest(intake.source(scope.mailboxUser, messageId).message);
      if (!businessRequest && classification?.workState === 'reference'
        && ['promotional-no-explicit-user-action', 'marketing-reference',
          'automatic-notification-reference', 'automated-notification-reference', 'low-value-automated-reference']
          .includes(classification.evidence?.workState?.rule)
        && !projection.correction
        && projection.customer?.status !== 'confirmed'
        && projection.project?.status !== 'confirmed') {
        candidateSkipped.push({ messageId, code: 'NON_BUSINESS_REFERENCE', rule: classification.evidence.workState.rule });
        continue;
      }
      if (companyMemory) {
        try {
          if (assertBinding) assertBinding();
          if (companyMemory.workspaceId !== scope.workspaceId) {
            throw Object.assign(new Error('COMPANY_WORKSPACE_MISMATCH'), { code: 'COMPANY_WORKSPACE_MISMATCH' });
          }
          const snapshot = intake.source(scope.mailboxUser, messageId);
          if (mailSourceDigest(snapshot.source) !== mailSourceDigest(projection.source)) {
            throw Object.assign(new Error('INTAKE_SOURCE_CHANGED'), { code: 'INTAKE_SOURCE_CHANGED' });
          }
          enqueueMailCompanyMemoryOutbox(store.db, {
            workspaceId: scope.workspaceId,
            kind: 'INBOX_RECEIVED',
            provider: companyMemory.provider,
            mailbox: snapshot.mailbox.address || snapshot.mailbox.graph_user || scope.mailboxKey,
            sourceLocator: snapshot.source.messageId,
            sourceEventId: snapshot.source.messageId,
          }, new Date().toISOString());
        } catch (error) {
          failures.push({ messageId, ...failure(error, 'COMPANY_MEMORY_ENQUEUE_FAILED') });
        }
      }
      const hasCandidates = ['customer', 'project'].some(type =>
        projection[type]?.candidates?.some(item => item.status === 'candidate'))
        || projection.work?.classification?.projectResolution === 'candidate';
      if (candidateWriter && hasCandidates && !candidateFailure) {
        const dispatchEntityId = JSON.stringify([scope.mailboxKey, scope.workspaceId, messageId]);
        let attemptId = null;
        try {
          const snapshot = intake.source(scope.mailboxUser, messageId);
          const fingerprint = mailSourceDigest(snapshot.source);
          const priorDelivery = store.latestAuditEvent('mail.crm_candidate.delivered', {
            entityType: 'message', entityId: messageId,
          });
          const alreadyDelivered = priorDelivery?.payload?.sourceDigest === fingerprint
            && priorDelivery.payload.workspaceId === scope.workspaceId;
          if (!alreadyDelivered) {
            const receipt = await candidateWriter.create({
              workspaceId: scope.workspaceId, ...snapshot, expectedVersion: candidateVersion,
              beforeDispatch: (identity) => {
                attemptId = beginCandidateDispatch(store, dispatchEntityId, {
                  ...identity, sourceDigest: fingerprint, workspaceId: scope.workspaceId,
                });
              },
              assertCurrent: () => {
                if (assertBinding) assertBinding();
                if (mailSourceDigest(intake.source(scope.mailboxUser, messageId).source) !== fingerprint) {
                  throw Object.assign(new Error('INTAKE_SOURCE_CHANGED'), { code: 'INTAKE_SOURCE_CHANGED' });
                }
              },
            });
            store.transaction(() => {
              store.audit('mail.crm_candidate.delivered', {
                entityType: 'message', entityId: messageId,
                payload: {
                  candidateId: receipt.id, workspaceId: scope.workspaceId,
                  runtimeVersion: receipt.runtimeVersion, sourceDigest: fingerprint,
                },
              });
              if (attemptId !== null) settleCandidateDispatch(store, dispatchEntityId, attemptId, 'delivered');
            });
            candidateVersion = receipt.runtimeVersion;
            deliveredCandidates.push({ messageId, ...receipt });
          }
        } catch (error) {
          if (attemptId !== null && error?.deliveryOutcome === 'rejected') {
            settleCandidateDispatch(store, dispatchEntityId, attemptId, 'rejected');
          }
          candidateFailure = { messageId, ...failure(error, 'CWOS_CANDIDATE_FAILED') };
          failures.push(candidateFailure);
        }
      }
    } catch (error) {
      if (error?.code === 'RECEIVED_MAIL_REQUIRED' || error?.code === 'MESSAGE_NOT_FOUND') {
        skipped.push({ messageId, code: error.code });
      } else {
        failures.push({ messageId, ...failure(error, 'INTAKE_FAILED') });
      }
    }
  }

  const summary = {
    denied: false,
    code: masterFailure?.code || '',
    mailboxUser: scope.mailboxKey,
    workspaceId: masterFailure ? '' : scope.workspaceId,
    mastersApplied: Boolean(scope.workspaceId && !masterFailure && !failures.some((item) => item.code === 'INTAKE_BINDING_STALE')),
    accepted: acceptedMessageIds.length,
    acceptedMessageIds,
    failures,
    skipped,
    candidateSkipped,
    deliveredCandidates,
  };
  store.audit('mail.intake.completed', {
    entityType: 'mailbox',
    entityId: scope.mailboxKey,
    payload: {
      accepted: summary.accepted,
      candidatesDelivered: deliveredCandidates.length,
      failed: failures.length,
      skipped: skipped.length,
      candidatesSkipped: candidateSkipped.length,
      mastersApplied: summary.mastersApplied,
      code: summary.code,
      mailbox: providerIdentity?.mailboxUser || scope.mailboxKey,
      tenantId: providerIdentity?.tenantId || '',
      principalId: providerIdentity?.principalId || '',
    },
  });
  return summary;
}
