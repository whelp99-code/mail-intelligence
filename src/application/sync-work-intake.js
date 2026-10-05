import { CwosWorkSystemAdapter } from '../adapters/cwos-work-system.js';
import { createIntakeAuthorization } from './intake-authorization.js';
import { MailWorkIntakeService } from './mail-work-intake.js';

function failure(error, fallbackCode) {
  return {
    code: error?.code || fallbackCode,
    message: String(error?.message || fallbackCode).slice(0, 200),
  };
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
  return { authorization: resolvedAuthorization, workSystem };
}

export async function ingestAfterCommittedSync({
  store,
  workSystem,
  authorization,
  mailboxUser = '',
  workspaceId = '',
  messageIds = [],
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
  const acceptedMessageIds = [];
  if (masterFailure?.code !== 'INTAKE_BINDING_STALE') for (const messageId of ids) {
    try {
      const projection = await intake.ingest(scope.mailboxUser, messageId, masterFailure
        ? { assertBinding, providerIdentity }
        : { workspaceId: scope.workspaceId, readResult, assertBinding, providerIdentity });
      acceptedMessageIds.push(projection.messageId);
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
  };
  store.audit('mail.intake.completed', {
    entityType: 'mailbox',
    entityId: scope.mailboxKey,
    payload: {
      accepted: summary.accepted,
      failed: failures.length,
      skipped: skipped.length,
      mastersApplied: summary.mastersApplied,
      code: summary.code,
      mailbox: providerIdentity?.mailboxUser || scope.mailboxKey,
      tenantId: providerIdentity?.tenantId || '',
      principalId: providerIdentity?.principalId || '',
    },
  });
  return summary;
}
