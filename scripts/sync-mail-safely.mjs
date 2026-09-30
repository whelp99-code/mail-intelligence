#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3010';
const APPROVED_AI_PROVIDERS = new Set(['xai-grok-oauth', 'openai-codex-oauth']);
const REQUEST_TIMEOUT_MS = 120_000;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function safeBaseUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_BASE_URL);
  } catch {
    fail('BASE_URL_INVALID');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    fail('BASE_URL_MUST_BE_LOOPBACK');
  }
  return url.origin;
}

async function responseJson(baseUrl, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      ...options,
    });
    if (!response.ok) fail(`HTTP_${response.status}`);
    const body = await response.json().catch(() => fail('RESPONSE_JSON_INVALID'));
    return { response, body };
  } catch (error) {
    if (error?.name === 'AbortError') fail('REQUEST_TIMEOUT');
    if (error?.code) throw error;
    fail('REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

async function sessionResponse(baseUrl, authorization) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/`, {
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Authorization: authorization },
    });
    if (!response.ok) fail(`HTTP_${response.status}`);
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') fail('REQUEST_TIMEOUT');
    if (error?.code) throw error;
    fail('REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

const SYNC_UNSAFE_CAPABILITIES = [
  'mailReadState',
  'mailMove',
  'mailDelete',
  'mailCategory',
  'calendarWrite',
  'taskWrite',
  'dataPlaneWrite',
];

function capabilityMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function sessionAllowsSync(value, allowApprovedSend) {
  const capabilities = capabilityMap(value);
  if (!capabilities || Object.keys(capabilities).length === 0) return false;
  return Object.entries(capabilities).every(([key, enabled]) => enabled === false || (allowApprovedSend && key === 'sendMail' && enabled === true));
}

function healthAllowsSync(body) {
  if (body?.ok !== true || body?.storage?.ready !== true) return false;
  const mode = body?.safety?.mode;
  const caps = capabilityMap(body?.safety?.capabilities);
  const publicCaps = capabilityMap(body?.capabilities);
  if (publicCaps && (publicCaps.markRead === true || publicCaps.dataPlane === true)) return false;
  if (mode === 'read-only' && body?.externalActionsAllowed === false) {
    if (caps && Object.values(caps).some((enabled) => enabled === true)) return false;
    if (publicCaps && (publicCaps.send === true)) return false;
    return true;
  }
  if (mode !== 'human-approved-mail-send' || !caps) return false;
  if (!SYNC_UNSAFE_CAPABILITIES.every((key) => caps[key] === false)) return false;
  if (caps.mailSend !== true && caps.mailSend !== false) return false;
  if (Object.entries(caps).some(([key, enabled]) => enabled === true && key !== 'mailSend')) return false;
  if (Object.values(caps).some((enabled) => enabled !== true && enabled !== false)) return false;
  if (body.externalActionsAllowed === true && caps.mailSend !== true) return false;
  if (body.externalActionsAllowed !== true && body.externalActionsAllowed !== false) return false;
  if (publicCaps?.send === true && caps.mailSend !== true) return false;
  return caps.mailSend === true || caps.mailSend === false;
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function integer(value) {
  return isCount(value) ? value : 0;
}

export async function syncMailSafely({
  baseUrl = DEFAULT_BASE_URL,
  accessKey,
  allowApprovedExternalAi = false,
} = {}) {
  const safeUrl = safeBaseUrl(baseUrl);
  if (!/^[A-Za-z0-9_-]{40,}$/.test(String(accessKey || ''))) fail('ACCESS_KEY_INVALID');

  const health = await responseJson(safeUrl, '/api/health');
  if (!healthAllowsSync(health.body)) fail('HEALTH_UNSAFE');
  const allowApprovedSend = health.body?.safety?.mode === 'human-approved-mail-send';

  const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
  const root = await sessionResponse(safeUrl, authorization);
  const cookie = (root.headers.get('set-cookie') || '').split(';')[0];
  await root.arrayBuffer().catch(() => fail('ROOT_RESPONSE_INVALID'));
  if (!/^mi_session=/.test(cookie)) fail('SESSION_COOKIE_MISSING');

  const session = await responseJson(safeUrl, '/api/session', { headers: { Cookie: cookie } });
  if (!session.body?.csrfToken || !sessionAllowsSync(session.body.capabilities, allowApprovedSend)) fail('SESSION_UNSAFE');

  const ai = await responseJson(safeUrl, '/api/ai/oauth/status', { headers: { Cookie: cookie } });
  let externalAi = 'disabled';
  if (ai.body?.externalAiEnabled !== false) {
    if (!allowApprovedExternalAi || ai.body?.externalAiEnabled !== true) fail('EXTERNAL_AI_ENABLED');
    if (ai.body?.dataPolicyAccepted !== true || !APPROVED_AI_PROVIDERS.has(ai.body?.selectedProvider)) fail('EXTERNAL_AI_UNAPPROVED');
    externalAi = 'approved';
  }

  const sync = await responseJson(safeUrl, '/api/outlook/sync', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: safeUrl,
      'Content-Type': 'application/json',
      'X-CSRF-Token': session.body.csrfToken,
      'X-Mail-Intelligence-Request': '1',
    },
    body: JSON.stringify({ top: 50, forceInitial: false }),
  });
  const detail = sync.body?.sync;
  if (sync.body?.connected !== true || sync.body?.mode === 'offline-cache') fail('OUTLOOK_OFFLINE');
  if (!detail
    || !isCount(detail.failedFolders)
    || !isCount(detail.completedFolders)
    || !isCount(detail.discoveredFolders)
    || !isCount(detail.attachmentErrors)
    || !isCount(detail.pagesProcessed)
    || !isCount(detail.fetchedFromGraph)
    || !isCount(detail.upserted)
    || !isCount(detail.deleted)
    || !isCount(detail.totalCached)
    || detail.mode !== 'delta'
    || detail.failedFolders !== 0
    || detail.completedFolders < 1
    || detail.discoveredFolders !== detail.completedFolders
    || detail.attachmentErrors !== 0
    || !Array.isArray(detail.errors)
    || detail.errors.length !== 0) fail('SYNC_INCOMPLETE');

  return {
    command: 'sync-mail-safely',
    status: 'PASS',
    completedAt: new Date().toISOString(),
    mode: detail.mode,
    externalAi,
    discoveredFolders: integer(detail.discoveredFolders),
    completedFolders: integer(detail.completedFolders),
    failedFolders: integer(detail.failedFolders),
    pagesProcessed: integer(detail.pagesProcessed),
    fetchedFromGraph: integer(detail.fetchedFromGraph),
    upserted: integer(detail.upserted),
    deleted: integer(detail.deleted),
    totalCached: integer(detail.totalCached),
  };
}

async function main() {
  const sourceIndex = process.argv.indexOf('--source-root');
  const sourceRoot = resolve(sourceIndex < 0 ? process.cwd() : process.argv[sourceIndex + 1] || '');
  const baseIndex = process.argv.indexOf('--base-url');
  const baseUrl = baseIndex < 0 ? DEFAULT_BASE_URL : process.argv[baseIndex + 1];
  const allowApprovedExternalAi = process.argv.includes('--allow-approved-external-ai');
  const accessKey = (await readFile(resolve(sourceRoot, 'data/.mail-intelligence-access-key'), 'utf8')).trim();
  process.stdout.write(`${JSON.stringify(await syncMailSafely({ baseUrl, accessKey, allowApprovedExternalAi }), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ command: 'sync-mail-safely', status: 'ERROR', code: String(error?.code || 'SYNC_FAILED') })}\n`);
    process.exitCode = 1;
  });
}
