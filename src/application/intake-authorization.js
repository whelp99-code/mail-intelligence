function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function mailboxKey(value = '') {
  return String(value || 'me').trim().toLowerCase() || 'me';
}

function hasDisallowedWorkspaceCharacter(value) {
  if (/\s/u.test(value)) return true;
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function workspaceId(value = '') {
  const workspace = String(value || '').trim();
  if (!workspace) return '';
  if (workspace.length > 200 || hasDisallowedWorkspaceCharacter(workspace)) fail('INTAKE_GRANT_INVALID', 500);
  return workspace;
}

export function intakeWorkspaceFromEnv(env = {}) {
  const value = String(env.MAIL_INTELLIGENCE_INTAKE_WORKSPACE || '').trim();
  if (!value) return '';
  if (value.length > 200 || hasDisallowedWorkspaceCharacter(value)) fail('INTAKE_WORKSPACE_INVALID', 500);
  return value;
}

// A grant binds one mailbox to at most one workspace. The request cannot widen either.
export function createIntakeAuthorization(grants = []) {
  if (!Array.isArray(grants)) fail('INTAKE_GRANT_INVALID', 500);
  const mailboxes = new Set();
  const workspaces = new Map();
  for (const grant of grants) {
    if (!grant || typeof grant.mailboxUser !== 'string') fail('INTAKE_GRANT_INVALID', 500);
    const key = mailboxKey(grant.mailboxUser);
    const workspace = workspaceId(grant.workspaceId);
    if (mailboxes.has(key) && (workspaces.get(key) || '') !== workspace) fail('INTAKE_GRANT_AMBIGUOUS', 500);
    mailboxes.add(key);
    if (workspace) workspaces.set(key, workspace);
  }

  return {
    bound: mailboxes.size > 0,
    workspaceFor(mailboxUser = '') {
      return workspaces.get(mailboxKey(mailboxUser)) || '';
    },
    authorize({ mailboxUser = '', workspaceId: requestedWorkspace = '' } = {}) {
      const key = mailboxKey(mailboxUser);
      if (mailboxes.size > 0 && !mailboxes.has(key)) fail('MAILBOX_NOT_AUTHORIZED');
      const requested = String(requestedWorkspace || '').trim();
      const allowed = workspaces.get(key) || '';
      if (requested && requested !== allowed) fail('WORKSPACE_NOT_AUTHORIZED');
      return { mailboxUser, mailboxKey: key, workspaceId: requested };
    },
  };
}

function cloneBinding(binding) {
  return binding ? { ...binding } : null;
}

// A loaded pin is expected identity, never startup authority.
export function createIntakeGrant({ binding = null, configuredWorkspaceId = '' } = {}) {
  let expected = cloneBinding(binding);
  let configuredWorkspace = String(configuredWorkspaceId || '').trim();
  let selection = expected?.mailboxUser || 'me';
  let generation = 0;
  let epoch = 1;
  let proof = null;

  function configured() {
    return Boolean(expected && configuredWorkspace && expected.workspaceId === configuredWorkspace);
  }

  function proven() {
    return Boolean(
      proof
      && configured()
      && proof.generation === generation
      && proof.epoch === epoch
      && proof.revision === expected.revision
      && proof.principalId === expected.principalId,
    );
  }

  function view() {
    return {
      get graphIdentityProven() {
        return proven();
      },
      get bound() {
        return configured();
      },
      epoch: () => epoch,
      capture: () => ({
        epoch,
        generation,
        revision: expected?.revision || 0,
        token: proof && proof.epoch === epoch && proof.generation === generation ? proof.accessToken : '',
      }),
      assertCurrent(captured) {
        if (!captured || captured.epoch !== epoch || captured.generation !== generation) fail('INTAKE_BINDING_STALE', 409);
        if ((captured.revision || 0) !== (expected?.revision || 0)) fail('INTAKE_BINDING_STALE', 409);
      },
      workspaceFor(mailboxUser = '') {
        if (!proven()) return '';
        return mailboxKey(mailboxUser) === expected.mailboxUser ? expected.workspaceId : '';
      },
      authorize({ mailboxUser: requestedMailbox = '', workspaceId: requestedWorkspace = '' } = {}) {
        if (!expected || !configuredWorkspace) fail('INTAKE_UNBOUND');
        if (expected.workspaceId !== configuredWorkspace) fail('INTAKE_UNBOUND');
        if (mailboxKey(selection) !== expected.mailboxUser || mailboxKey(requestedMailbox) !== expected.mailboxUser) {
          fail('MAILBOX_NOT_AUTHORIZED');
        }
        if (!proven()) fail('INTAKE_IDENTITY_UNPROVEN');
        return createIntakeAuthorization([{
          mailboxUser: expected.mailboxUser,
          workspaceId: expected.workspaceId,
        }]).authorize({ mailboxUser: requestedMailbox, workspaceId: requestedWorkspace });
      },
      identityProvenance() {
        if (!proven()) fail('INTAKE_IDENTITY_UNPROVEN');
        return {
          provider: 'microsoft-graph',
          mailboxUser: expected.mailboxUser,
          tenantId: expected.tenantId,
          principalId: expected.principalId,
        };
      },
    };
  }

  return {
    get graphIdentityProven() {
      return proven();
    },
    get configured() {
      return configured();
    },
    expectedBinding() {
      return cloneBinding(expected);
    },
    captureEpoch() {
      return epoch;
    },
    observeSelection(mailboxUser = '') {
      const key = mailboxKey(mailboxUser);
      if (key === selection) return false;
      selection = key;
      epoch += 1;
      return true;
    },
    noteTokenReplacement() {
      generation += 1;
      epoch += 1;
      proof = null;
    },
    invalidateProof() {
      epoch += 1;
      proof = null;
    },
    rebind() {
      fail('INTAKE_GRANT_EXPLICIT', 400);
    },
    publishProof(verified, capturedEpoch) {
      if (capturedEpoch !== epoch) fail('INTAKE_BINDING_STALE', 409);
      if (!verified || !expected || verified.revision !== expected.revision) fail('INTAKE_BINDING_STALE', 409);
      if (verified.principalId !== expected.principalId || !verified.accessToken) fail('INTAKE_IDENTITY_MISMATCH');
      proof = {
        accessToken: verified.accessToken,
        generation,
        epoch,
        revision: expected.revision,
        principalId: expected.principalId,
      };
      return {
        mailboxUser: expected.mailboxUser,
        workspaceId: expected.workspaceId,
        revision: expected.revision,
        graphIdentityProven: true,
      };
    },
    async publishRegistration({ next, verified, capturedEpoch, write }) {
      if (capturedEpoch !== epoch) fail('INTAKE_BINDING_STALE', 409);
      if (typeof write !== 'function') fail('INTAKE_BINDING_PERSIST_FAILED', 500);
      if (!next || !verified?.accessToken) fail('INTAKE_IDENTITY_UNPROVEN');
      if (
        verified.principalId !== next.principalId
        || verified.clientId !== next.clientId
        || verified.tenantId !== next.tenantId
        || verified.revision !== next.revision
      ) {
        fail('INTAKE_IDENTITY_MISMATCH');
      }
      const saved = await write(next);
      if (capturedEpoch !== epoch) fail('INTAKE_BINDING_STALE', 409);
      expected = cloneBinding(saved);
      selection = expected.mailboxUser;
      proof = {
        accessToken: verified.accessToken,
        generation,
        epoch,
        revision: expected.revision,
        principalId: expected.principalId,
      };
      return {
        mailboxUser: expected.mailboxUser,
        workspaceId: expected.workspaceId,
        revision: expected.revision,
        graphIdentityProven: true,
      };
    },
    authorization: view,
    freezeVerified(accessToken) {
      const snapshot = view().capture();
      if (!proven() || snapshot.token !== accessToken) fail('INTAKE_IDENTITY_UNPROVEN');
      const assertFrozen = () => {
        const current = view().capture();
        if (
          !proven()
          || current.token !== snapshot.token
          || current.epoch !== snapshot.epoch
          || current.generation !== snapshot.generation
          || current.revision !== snapshot.revision
        ) {
          fail('INTAKE_BINDING_STALE', 409);
        }
      };
      return {
        get graphIdentityProven() {
          assertFrozen();
          return true;
        },
        get bound() {
          return true;
        },
        epoch: () => snapshot.epoch,
        capture: () => ({ ...snapshot }),
        assertCurrent(captured) {
          assertFrozen();
          if (!captured || captured.token !== snapshot.token || captured.epoch !== snapshot.epoch) {
            fail('INTAKE_BINDING_STALE', 409);
          }
        },
        workspaceFor(mailboxUser = '') {
          assertFrozen();
          return view().workspaceFor(mailboxUser);
        },
        authorize(request) {
          assertFrozen();
          return view().authorize(request);
        },
        identityProvenance() {
          assertFrozen();
          return view().identityProvenance();
        },
      };
    },
  };
}

// Same mailbox and the same access token do not advance token generation.
// A changed token invalidates the grant in the same synchronous step as the
// in-memory replacement, before any persistence await.
export function noteAccessTokenReplacement(grant, runtimeConfig, previousToken, mailboxUser = 'me') {
  grant.observeSelection(mailboxUser || 'me');
  if ((runtimeConfig.accessToken || '') !== previousToken) grant.noteTokenReplacement();
}

export function noteClientTenantChange(grant, previous = {}, next = {}) {
  const clientId = String(next.clientId || '');
  const tenantId = String(next.tenantId || '');
  if (String(previous.clientId || '') !== clientId || String(previous.tenantId || '') !== tenantId) {
    grant.invalidateProof();
  }
  return { clientId, tenantId };
}

export async function publishRefreshedAccessToken(runtimeConfig, payload, noteChange, persist) {
  const previousToken = runtimeConfig.accessToken || '';
  runtimeConfig.accessToken = payload.access_token || '';
  runtimeConfig.refreshToken = payload.refresh_token || runtimeConfig.refreshToken;
  runtimeConfig.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  noteChange(previousToken);
  await persist();
  return runtimeConfig.accessToken;
}
