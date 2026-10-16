import test from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  accessAuthorizationHeader,
  basicAccessGranted,
  configuredAccessUsername,
} from '../src/security/access-user.js';

const SYNTHETIC_KEY = 'synthetic-access-key-0001';
const OTHER_KEY = 'synthetic-access-key-0002';

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

test('a missing or blank login id keeps the historical username', () => {
  assert.equal(configuredAccessUsername({}), 'mailintelligence');
  assert.equal(configuredAccessUsername({ MAIL_INTELLIGENCE_ACCESS_USER: '' }), 'mailintelligence');
  assert.equal(configuredAccessUsername({ MAIL_INTELLIGENCE_ACCESS_USER: ' \n\t' }), 'mailintelligence');
});

test('a configured login id is the only username that passes', () => {
  const env = { MAIL_INTELLIGENCE_ACCESS_USER: ' synthetic-operator ' };
  assert.equal(configuredAccessUsername(env), 'synthetic-operator');
  assert.equal(basicAccessGranted('synthetic-operator', SYNTHETIC_KEY, SYNTHETIC_KEY, constantTimeEquals, env), true);
  assert.equal(basicAccessGranted('mailintelligence', SYNTHETIC_KEY, SYNTHETIC_KEY, constantTimeEquals, env), false);
  assert.equal(basicAccessGranted('synthetic-operator', OTHER_KEY, SYNTHETIC_KEY, constantTimeEquals, env), false);
});

test('without a configured login id only the historical username passes', () => {
  const env = {};
  assert.equal(basicAccessGranted('mailintelligence', SYNTHETIC_KEY, SYNTHETIC_KEY, constantTimeEquals, env), true);
  assert.equal(basicAccessGranted('synthetic-operator', SYNTHETIC_KEY, SYNTHETIC_KEY, constantTimeEquals, env), false);
  assert.equal(basicAccessGranted('mailintelligence', OTHER_KEY, SYNTHETIC_KEY, constantTimeEquals, env), false);
});

test('the password comparison is the supplied constant-time function', () => {
  const calls = [];
  const equals = (left, right) => {
    calls.push([left, right]);
    return constantTimeEquals(left, right);
  };
  assert.equal(basicAccessGranted('mailintelligence', SYNTHETIC_KEY, SYNTHETIC_KEY, equals, {}), true);
  assert.deepEqual(calls, [[SYNTHETIC_KEY, SYNTHETIC_KEY]]);
  assert.equal(basicAccessGranted('other-user', SYNTHETIC_KEY, SYNTHETIC_KEY, equals, {}), false);
  assert.equal(calls.length, 1);
});

test('the server keeps constantTimeEquals for the access key', async () => {
  const source = await readFile(join(process.cwd(), 'server.mjs'), 'utf8');
  assert.match(source, /basicAccessGranted\(username, password, configuredAccessKey, constantTimeEquals\)/);
  assert.doesNotMatch(source, /username === 'mailintelligence'/);
});

test('the authorization header uses the configured username and not a stored key', () => {
  const header = accessAuthorizationHeader(SYNTHETIC_KEY, { MAIL_INTELLIGENCE_ACCESS_USER: 'synthetic-operator' });
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  assert.equal(decoded, `synthetic-operator:${SYNTHETIC_KEY}`);
  assert.equal(
    accessAuthorizationHeader(SYNTHETIC_KEY, {}).startsWith('Basic '),
    true,
  );
});
