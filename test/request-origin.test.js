import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOriginAllowed, requestOriginScheme } from '../src/security/request-origin.js';

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

test('loopback https origin matches even when the parsed URL is http', () => {
  const url = new URL('http://mail.example.ts.net:8451/api/messages/handled-elsewhere');
  const allowed = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: 'mail.example.ts.net:8451',
      origin: 'https://mail.example.ts.net:8451',
      'x-forwarded-proto': 'https',
      'x-real-ip': '203.0.113.9',
    },
  };
  assert.equal(browserOriginAllowed(allowed, url), true);
  assert.equal(browserOriginAllowed({
    socket: { remoteAddress: '172.30.0.2' },
    headers: { ...allowed.headers, forwarded: 'for=127.0.0.1;proto=https' },
  }, url), false);
  assert.equal(browserOriginAllowed({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...allowed.headers, origin: 'https://attacker.invalid' },
  }, url), false);
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
