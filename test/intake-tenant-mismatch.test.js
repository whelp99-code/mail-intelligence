import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PersistentMailMemoryRuntime } from '../src/application/persistent-mail-memory.js';
import { createIntakeGrant, noteClientTenantChange } from '../src/application/intake-authorization.js';
import {
  captureVerifiedIntakeSync,
  classifyIdentityFailure,
  proveDelegatedIdentity,
} from '../src/application/intake-identity.js';
import { syntheticIdentityToken } from './fixtures/synthetic-identity-token.mjs';

const workspaceId = 'synthetic-workspace';
const pin = {
  version: 1,
  revision: 1,
  workspaceId,
  mailboxUser: 'me',
  tenantId: 'tenant-synthetic',
  principalId: 'principal-synthetic',
  mailboxId: 'principal-synthetic',
  clientId: 'client-synthetic',
  intentReference: 'synthetic-operator-registration',
};

function profile(id) {
  return { ok: true, async json() { return { id }; } };
}

test('a specific configured tenant that is not the pin cannot republish canonical intake', { timeout: 10000 }, async (t) => {
  let identityCalls = 0;
  const allowed = await proveDelegatedIdentity({
    accessToken: syntheticIdentityToken(pin),
    binding: pin,
    endpoint: 'http://127.0.0.1/me',
    fetchImpl: async () => {
      identityCalls += 1;
      return profile(pin.principalId);
    },
    configuredTenantId: 'common',
  });
  assert.equal(allowed.tenantId, pin.tenantId);
  assert.equal(identityCalls, 1);

  await assert.rejects(proveDelegatedIdentity({
    accessToken: syntheticIdentityToken(pin),
    binding: pin,
    endpoint: 'http://127.0.0.1/me',
    fetchImpl: async () => {
      identityCalls += 1;
      return profile(pin.principalId);
    },
    configuredTenantId: 'tenant-revoked',
  }), { code: 'INTAKE_IDENTITY_MISMATCH' });
  assert.equal(identityCalls, 1);

  const directory = await mkdtemp(join(tmpdir(), 'w06-tenant-mismatch-'));
  const runtime = new PersistentMailMemoryRuntime({
    databasePath: join(directory, 'mail.sqlite'),
    migrationsDir: resolve('migrations'),
    backupDirectory: join(directory, 'backups'),
    graphBaseUrl: 'http://127.0.0.1:9/v1.0',
    fetchImpl: async () => {
      throw new Error('graph must not be called');
    },
  });
  await runtime.initialize();
  t.after(async () => {
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const grant = createIntakeGrant({ binding: pin, configuredWorkspaceId: workspaceId });
  const token = syntheticIdentityToken(pin);
  grant.publishProof(allowed, grant.captureEpoch());
  assert.equal(grant.graphIdentityProven, true);
  noteClientTenantChange(grant, { clientId: pin.clientId, tenantId: pin.tenantId }, {
    clientId: pin.clientId,
    tenantId: 'tenant-revoked',
  });
  assert.equal(grant.graphIdentityProven, false);
  let cwosReads = 0;
  runtime.setWorkIntakeGate(({ accessToken, mailboxUser }) => captureVerifiedIntakeSync({
    grant,
    accessToken,
    mailboxUser,
    reverify: async (candidate) => {
      try {
        const verified = await proveDelegatedIdentity({
          accessToken: candidate,
          binding: grant.expectedBinding(),
          endpoint: 'http://127.0.0.1/me',
          fetchImpl: async () => {
            identityCalls += 1;
            return profile(pin.principalId);
          },
          configuredTenantId: 'tenant-revoked',
        });
        return grant.publishProof(verified, grant.captureEpoch());
      } catch (error) {
        const refusal = classifyIdentityFailure(error);
        if (!refusal) return null;
        if (grant.graphIdentityProven) grant.invalidateProof();
        return { denied: refusal };
      }
    },
  }));
  runtime.bindWorkIntake(() => ({
    authorization: grant.authorization(),
    workSystem: {
      async readMasters() {
        cwosReads += 1;
        return { workspaceId, items: [] };
      },
    },
  }));
  await assert.rejects(runtime.syncMailbox({ accessToken: token, mailboxUser: 'me' }), {
    code: 'INTAKE_IDENTITY_MISMATCH',
  });
  assert.equal(identityCalls, 1);
  assert.equal(cwosReads, 0);
  assert.equal(grant.graphIdentityProven, false);
});
