import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertMutationAllowed,
  delegatedScopesForSafety,
  getSafetyPolicy,
  MutationDisabledError,
  normalizeLoopbackHost,
  normalizePort,
  UnsafeListenHostError
} from '../src/safety.js';

test('v1.2.2 safety policy is strictly read-only', () => {
  const policy = getSafetyPolicy();
  assert.equal(policy.mode, 'read-only');
  assert.equal(policy.policyVersion, 'read-only-v1.2.2');
  for (const [capability, enabled] of Object.entries(policy.capabilities)) {
    assert.equal(enabled, false, `${capability} must be disabled`);
  }
});

test('Graph delegated consent contains read scope and excludes mutation scopes', () => {
  const scopes = delegatedScopesForSafety(getSafetyPolicy({}), {}).split(/\s+/);
  assert.ok(scopes.includes('Mail.Read'));
  assert.ok(!scopes.includes('Mail.Send'));
  assert.ok(!scopes.includes('Mail.ReadWrite'));
  assert.equal(scopes.includes('Calendars.ReadBasic'), false);
});

test('calendar reader flag adds only delegated Calendars.ReadBasic', () => {
  const policy = getSafetyPolicy({});
  const enabled = delegatedScopesForSafety(policy, { MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED: '1' }).split(/\s+/);
  assert.ok(enabled.includes('Calendars.ReadBasic'));
  assert.equal(enabled.includes('Calendars.Read'), false);
  assert.equal(enabled.includes('Calendars.ReadWrite'), false);
  assert.equal(enabled.includes('Calendars.ReadBasic.All'), false);
  const ignored = delegatedScopesForSafety(policy, { MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED: 'true' });
  assert.equal(ignored.includes('Calendars.ReadBasic'), false);
  assert.equal(
    delegatedScopesForSafety(policy).includes('Calendars.ReadBasic'),
    String(process.env.MAIL_INTELLIGENCE_JARVIS_CALENDAR_READER_ENABLED || '') === '1',
    'omitted env must follow process.env, matching the server authorize/token/refresh/graphConsent call',
  );
});

test('mutation assertion fails closed with a stable error contract', () => {
  assert.throws(
    () => assertMutationAllowed('mailSend'),
    (error) => {
      assert.ok(error instanceof MutationDisabledError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'MUTATION_DISABLED');
      assert.equal(error.capability, 'mailSend');
      return true;
    }
  );
});

test('listen host and port fail closed outside the local boundary', () => {
  assert.equal(normalizeLoopbackHost('127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeLoopbackHost('LOCALHOST'), 'localhost');
  assert.equal(normalizeLoopbackHost('::1'), '::1');
  assert.throws(
    () => normalizeLoopbackHost('0.0.0.0'),
    (error) => error instanceof UnsafeListenHostError && error.code === 'LISTEN_HOST_NOT_LOOPBACK'
  );
  assert.equal(normalizePort('3010'), 3010);
  assert.equal(normalizePort('0'), 0);
  assert.throws(() => normalizePort('70000'), (error) => error.code === 'PORT_INVALID');
});
