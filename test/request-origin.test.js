import test from 'node:test';
import assert from 'node:assert/strict';
import { requestOriginScheme } from '../src/security/request-origin.js';

test('loopback peer with X-Forwarded-Proto https uses https', () => {
  assert.equal(requestOriginScheme({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-proto': 'https' },
  }), 'https');
  assert.equal(requestOriginScheme({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-proto': 'HTTPS' },
  }), 'https');
});

test('https forwarding from a non-loopback peer stays http', () => {
  assert.equal(requestOriginScheme({
    socket: { remoteAddress: '100.87.253.57' },
    headers: { 'x-forwarded-proto': 'https' },
  }), 'http');
});

test('loopback without forwarded https stays http', () => {
  assert.equal(requestOriginScheme({
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  }), 'http');
  assert.equal(requestOriginScheme({
    socket: { remoteAddress: '::1' },
    headers: { 'x-forwarded-proto': 'http' },
  }), 'http');
});
