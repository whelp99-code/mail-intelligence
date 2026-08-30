import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHostname, validateServiceUrl } from '../src/security/service-url.js';

test('loopback 서비스 URL은 기본 허용한다', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(validateServiceUrl('http://localhost:3201/', { label: 'AI URL' }), 'http://localhost:3201');
});

test('원격 서비스 URL은 명시적 승인 없이는 거부한다', () => {
  assert.throws(
    () => validateServiceUrl('https://example.com/hook', { label: 'Hook URL' }),
    (error) => error.statusCode === 403 && error.code === 'REMOTE_SERVICE_DISABLED'
  );
  assert.equal(
    validateServiceUrl('https://example.com/hook', { label: 'Hook URL', allowRemote: true }),
    'https://example.com/hook'
  );
});

test('자격증명 포함 URL과 비 HTTP(S) 프로토콜을 거부한다', () => {
  assert.throws(
    () => validateServiceUrl('http://user:password@localhost:3201'),
    (error) => error.code === 'SERVICE_URL_CREDENTIALS_FORBIDDEN'
  );
  assert.throws(
    () => validateServiceUrl('file:///tmp/data'),
    (error) => error.code === 'INVALID_SERVICE_URL_PROTOCOL'
  );
});

test('잘못된 절대 URL을 명시적 오류로 거부한다', () => {
  assert.throws(
    () => validateServiceUrl('not-a-url'),
    (error) => error.statusCode === 400 && error.code === 'INVALID_SERVICE_URL'
  );
});
