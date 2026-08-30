import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCapability,
  delegatedScopesForPolicy,
  getSafetyPolicy,
  publicCapabilities
} from '../src/security/safety-policy.js';

test('외부 행동은 환경변수를 명시하지 않으면 모두 잠긴다', () => {
  const policy = getSafetyPolicy({});
  assert.deepEqual(publicCapabilities(policy), {
    readOnly: true,
    send: false,
    mailMutations: false,
    dataPlane: false,
    externalAi: false
  });
  assert.equal(policy.bindHost, '127.0.0.1');
  assert.throws(() => assertCapability(policy, 'send'), (error) => error.statusCode === 403);
  assert.throws(() => assertCapability(policy, 'mailMutation'), (error) => error.statusCode === 403);
  assert.throws(() => assertCapability(policy, 'dataPlane'), (error) => error.statusCode === 403);
  assert.throws(() => assertCapability(policy, 'externalAi'), (error) => error.statusCode === 403);
});

test('읽기 전용 OAuth scope에는 Mail.Send가 포함되지 않는다', () => {
  const scopes = delegatedScopesForPolicy(getSafetyPolicy({}));
  assert.match(scopes, /Mail\.Read/);
  assert.doesNotMatch(scopes, /Mail\.Send/);
});

test('발송 게이트가 명시적으로 열린 경우에만 Mail.Send scope를 추가한다', () => {
  const policy = getSafetyPolicy({ MAIL_INTELLIGENCE_ALLOW_SEND: '1' });
  assert.doesNotThrow(() => assertCapability(policy, 'send'));
  assert.match(delegatedScopesForPolicy(policy), /Mail\.Send/);
});
