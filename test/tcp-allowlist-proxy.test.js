import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  clientAddressAllowed,
  createAllowlistedTcpProxy,
  ipv4InCidr,
  normalizeIpv4,
  parseIpv4Cidr,
  parseTailnetAllowedHosts,
  validateProxyConfig,
} from '../src/security/tcp-allowlist-proxy.js';

function listenHttp(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeHttp(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('tailnet CIDR parser accepts Tailscale addresses and rejects unrelated networks', () => {
  const tailnet = parseIpv4Cidr('100.64.0.0/10');
  assert.equal(ipv4InCidr('100.87.81.57', tailnet), true);
  assert.equal(ipv4InCidr('100.127.255.254', tailnet), true);
  assert.equal(ipv4InCidr('100.128.0.1', tailnet), false);
  assert.equal(ipv4InCidr('192.168.100.5', tailnet), false);
  assert.equal(normalizeIpv4('::ffff:100.87.81.57'), '100.87.81.57');
  assert.equal(clientAddressAllowed('::ffff:100.87.81.57', [tailnet]), true);
  assert.deepEqual(parseTailnetAllowedHosts('100.87.81.57,100.87.81.57'), ['100.87.81.57']);
  assert.throws(
    () => parseTailnetAllowedHosts('192.168.100.5'),
    /outside the tailnet CIDR/i,
  );
});

test('proxy configuration fails closed for wildcard, loopback bind and non-loopback target', () => {
  assert.throws(
    () => validateProxyConfig({ bindHost: '0.0.0.0', allowedCidrs: '100.64.0.0/10' }),
    /explicit non-loopback/i,
  );
  assert.throws(
    () => validateProxyConfig({ bindHost: '127.0.0.1', allowedCidrs: '127.0.0.0/8' }),
    /explicit non-loopback/i,
  );
  assert.throws(
    () => validateProxyConfig({
      bindHost: '100.87.81.57',
      allowedCidrs: '100.64.0.0/10',
      targetHost: '192.168.100.5',
    }),
    /target host must remain/i,
  );
  assert.throws(
    () => validateProxyConfig({ bindHost: '192.168.100.5', allowedCidrs: '100.64.0.0/10' }),
    /belong to an allowed CIDR/i,
  );
});

test('allowlisted TCP proxy forwards bytes to a loopback backend', async (t) => {
  const backend = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, path: request.url }));
  });
  const backendAddress = await listenHttp(backend);
  t.after(() => closeHttp(backend));

  const proxy = createAllowlistedTcpProxy({
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: backendAddress.port,
    allowedCidrs: [parseIpv4Cidr('127.0.0.0/8')],
    maxConnections: 8,
    idleTimeoutMs: 5_000,
  });
  const proxyAddress = await proxy.listen();
  t.after(() => proxy.close());

  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/probe`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, path: '/probe' });
});

test('allowlisted TCP proxy drops clients outside the configured CIDR', async (t) => {
  const backend = createServer((_request, response) => response.end('unexpected'));
  const backendAddress = await listenHttp(backend);
  t.after(() => closeHttp(backend));

  const proxy = createAllowlistedTcpProxy({
    bindHost: '127.0.0.1',
    bindPort: 0,
    targetHost: '127.0.0.1',
    targetPort: backendAddress.port,
    allowedCidrs: [parseIpv4Cidr('100.64.0.0/10')],
    maxConnections: 8,
    idleTimeoutMs: 5_000,
  });
  const proxyAddress = await proxy.listen();
  t.after(() => proxy.close());

  await assert.rejects(
    fetch(`http://127.0.0.1:${proxyAddress.port}/blocked`),
    /fetch failed/i,
  );
});
