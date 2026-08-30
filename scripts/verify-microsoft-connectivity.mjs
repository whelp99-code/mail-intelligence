#!/usr/bin/env node

import assert from 'node:assert/strict';

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);

try {
  const discoveryResponse = await fetch(
    'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    { signal: controller.signal, cache: 'no-store' },
  );
  assert.equal(discoveryResponse.status, 200);
  const discovery = await discoveryResponse.json();
  const authorizationEndpoint = new URL(discovery.authorization_endpoint);
  const tokenEndpoint = new URL(discovery.token_endpoint);
  assert.equal(authorizationEndpoint.hostname, 'login.microsoftonline.com');
  assert.equal(tokenEndpoint.hostname, 'login.microsoftonline.com');

  const graphResponse = await fetch('https://graph.microsoft.com/v1.0/', {
    signal: controller.signal,
    cache: 'no-store',
    redirect: 'manual',
  });
  assert.ok([200, 401, 403, 404].includes(graphResponse.status));
  await graphResponse.arrayBuffer();

  console.log(JSON.stringify({
    microsoftConnectivity: 'PASS',
    loginDiscoveryStatus: discoveryResponse.status,
    authorizationHost: authorizationEndpoint.hostname,
    tokenHost: tokenEndpoint.hostname,
    graphHost: 'graph.microsoft.com',
    graphUnauthenticatedStatus: graphResponse.status,
  }, null, 2));
} finally {
  clearTimeout(timeout);
}
