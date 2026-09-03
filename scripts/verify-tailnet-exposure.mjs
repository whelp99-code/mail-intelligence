#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function parseEnvironment(source) {
  return Object.fromEntries(String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('Invalid tailnet proxy environment line.');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

async function jsonResponse(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const proxyEnvPath = process.env.MAIL_INTELLIGENCE_PROXY_ENV_FILE
  || new URL('../data/tailnet-proxy.env', import.meta.url);
const accessKeyPath = process.env.MAIL_INTELLIGENCE_ACCESS_KEY_FILE
  || new URL('../data/.mail-intelligence-access-key', import.meta.url);
const proxyEnv = parseEnvironment(await readFile(proxyEnvPath, 'utf8'));
const bindHost = proxyEnv.MAIL_INTELLIGENCE_PROXY_BIND;
const bindPort = Number.parseInt(proxyEnv.MAIL_INTELLIGENCE_PROXY_PORT || '3010', 10);
assert.match(bindHost || '', /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(?:\d{1,3})\.(?:\d{1,3})$/);
assert.equal(bindPort, 3010);
const baseUrl = `http://${bindHost}:${bindPort}`;

const health = await jsonResponse(baseUrl, '/api/health');
assert.equal(health.response.status, 200);
assert.equal(health.body.ok, true);
assert.equal(health.body.version, '1.2.2');
assert.equal(health.body.listenHost, '127.0.0.1');
assert.equal(health.body.safety?.mode, 'read-only');
assert.equal(health.body.externalActionsAllowed, false);
assert.equal(health.body.graphConsent?.includes('Mail.Send'), false);
assert.equal(health.body.graphConsent?.includes('Mail.ReadWrite'), false);

const unauthenticatedRoot = await fetch(`${baseUrl}/`, { redirect: 'manual' });
assert.equal(unauthenticatedRoot.status, 401);
assert.match(unauthenticatedRoot.headers.get('www-authenticate') || '', /Mail Intelligence/);

const accessKey = (await readFile(accessKeyPath, 'utf8')).trim();
assert.match(accessKey, /^[A-Za-z0-9_-]{40,}$/);
const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
const authenticatedRoot = await fetch(`${baseUrl}/`, {
  redirect: 'manual',
  headers: { Authorization: authorization },
});
assert.equal(authenticatedRoot.status, 200);
const html = await authenticatedRoot.text();
assert.match(html, /v1\.2\.2 · Operational Classification/);
const cookie = (authenticatedRoot.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^mi_session=/);

const session = await jsonResponse(baseUrl, '/api/session', { headers: { Cookie: cookie } });
assert.equal(session.response.status, 200);
assert.ok(session.body.csrfToken);
assert.deepEqual(session.body.capabilities, { sendMail: false, markRead: false, dataPlane: false });

const summary = await jsonResponse(baseUrl, '/api/intelligence/summary', {
  headers: { Cookie: cookie },
});
assert.equal(summary.response.status, 200, JSON.stringify(summary.body));
assert.ok(summary.body.states);

const smartViews = await jsonResponse(baseUrl, '/api/intelligence/smart-views', {
  headers: { Cookie: cookie },
});
assert.equal(smartViews.response.status, 200, JSON.stringify(smartViews.body));
assert.ok(Array.isArray(smartViews.body.views));

const blockedSend = await jsonResponse(baseUrl, '/api/outlook/send', {
  method: 'POST',
  headers: {
    Cookie: cookie,
    Origin: baseUrl,
    'Content-Type': 'application/json',
    'X-CSRF-Token': session.body.csrfToken,
    'X-Mail-Intelligence-Request': '1',
  },
  body: JSON.stringify({
    to: 'nobody@example.invalid',
    subject: 'must remain blocked',
    body: 'must remain blocked',
  }),
});
assert.equal(blockedSend.response.status, 403);
assert.equal(blockedSend.body.code, 'EXTERNAL_ACTION_DISABLED');

console.log(JSON.stringify({
  tailnetExposure: 'PASS',
  endpoint: baseUrl,
  transport: 'tailscale-wireguard-http',
  sourceAllowlist: proxyEnv.MAIL_INTELLIGENCE_PROXY_ALLOWED_CIDRS,
  backendListenHost: health.body.listenHost,
  authenticationRequired: true,
  safetyMode: health.body.safety.mode,
  precisionSummaryAvailable: true,
  smartViews: smartViews.body.views.length,
  externalSendBlocked: true,
}, null, 2));
