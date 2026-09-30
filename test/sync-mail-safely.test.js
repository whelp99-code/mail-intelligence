import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { syncMailSafely } from '../scripts/sync-mail-safely.mjs';

const accessKey = 'a'.repeat(40);

async function withServer(t, overrides = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let requestBody = '';
    for await (const chunk of request) requestBody += chunk.toString();
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: requestBody });
    const body = overrides[`${request.method} ${request.url}`] || defaultResponse(request);
    response.writeHead(body.status || 200, body.headers || { 'Content-Type': 'application/json' });
    response.end(typeof body.body === 'string' ? body.body : JSON.stringify(body.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => server.close());
  return { requests, baseUrl: `http://127.0.0.1:${port}` };
}

function defaultResponse(request) {
  if (request.url === '/api/health') return { body: { ok: true, storage: { ready: true }, safety: { mode: 'read-only' }, externalActionsAllowed: false } };
  if (request.url === '/') return { headers: { 'Set-Cookie': 'mi_session=test; HttpOnly' }, body: 'ok' };
  if (request.url === '/api/session') return { body: { csrfToken: 'csrf', capabilities: { sendMail: false, markRead: false, dataPlane: false } } };
  if (request.url === '/api/ai/oauth/status') return { body: { externalAiEnabled: false } };
  if (request.url === '/api/outlook/sync') return { body: { connected: true, mode: 'delegated-me', messages: [{ secret: 'must-not-output' }], sync: { mode: 'delta', discoveredFolders: 2, completedFolders: 2, failedFolders: 0, attachmentErrors: 0, errors: [], pagesProcessed: 3, fetchedFromGraph: 4, upserted: 4, deleted: 1, totalCached: 9 } } };
  return { status: 404, body: {} };
}

test('safe sync sends exactly one allowed mutation and exposes aggregate-only result', async (t) => {
  const { baseUrl, requests } = await withServer(t);
  const result = await syncMailSafely({ baseUrl, accessKey });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(Object.keys(result).sort(), ['command', 'completedAt', 'completedFolders', 'deleted', 'discoveredFolders', 'externalAi', 'failedFolders', 'fetchedFromGraph', 'mode', 'pagesProcessed', 'status', 'totalCached', 'upserted']);
  assert.equal(result.externalAi, 'disabled');
  assert.match(result.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const mutations = requests.filter((item) => item.method !== 'GET');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/outlook/sync');
  assert.equal(mutations[0].headers.origin, baseUrl);
  assert.equal(mutations[0].headers['x-csrf-token'], 'csrf');
  assert.equal(mutations[0].headers['content-type'], 'application/json');
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(mutations[0].body, JSON.stringify({ top: 50, forceInitial: false }));
});

for (const [name, path, body, code] of [
  ['offline 200 response', 'POST /api/outlook/sync', { connected: false, mode: 'offline-cache', sync: { completedFolders: 1, failedFolders: 0, discoveredFolders: 1, attachmentErrors: 0, errors: [], pagesProcessed: 0, fetchedFromGraph: 0, upserted: 0, deleted: 0, totalCached: 0 } }, 'OUTLOOK_OFFLINE'],
  ['partial folder failure', 'POST /api/outlook/sync', { connected: true, mode: 'delegated-me', sync: { completedFolders: 1, discoveredFolders: 2, failedFolders: 1, attachmentErrors: 0, errors: [] } }, 'SYNC_INCOMPLETE'],
  ['unsafe health', 'GET /api/health', { ok: true, storage: { ready: true }, safety: { mode: 'read-only' }, externalActionsAllowed: true }, 'HEALTH_UNSAFE'],
  ['external AI enabled', 'GET /api/ai/oauth/status', { externalAiEnabled: true }, 'EXTERNAL_AI_ENABLED'],
]) {
  test(`safe sync rejects ${name}`, async (t) => {
    const { baseUrl, requests } = await withServer(t, { [path]: { body } });
    await assert.rejects(() => syncMailSafely({ baseUrl, accessKey }), { code });
    if (code !== 'OUTLOOK_OFFLINE' && code !== 'SYNC_INCOMPLETE') {
      assert.equal(requests.some((item) => item.method === 'POST'), false);
    }
  });
}

const approvedAi = { externalAiEnabled: true, dataPolicyAccepted: true, selectedProvider: 'xai-grok-oauth' };

test('safe sync proceeds with approved external AI only when the operator opts in', async (t) => {
  const { baseUrl, requests } = await withServer(t, { 'GET /api/ai/oauth/status': { body: approvedAi } });
  const result = await syncMailSafely({ baseUrl, accessKey, allowApprovedExternalAi: true });
  assert.equal(result.status, 'PASS');
  assert.equal(result.externalAi, 'approved');
  assert.deepEqual(requests.filter((item) => item.method === 'POST').map((item) => item.url), ['/api/outlook/sync']);
  const withoutOptIn = await withServer(t, { 'GET /api/ai/oauth/status': { body: approvedAi } });
  await assert.rejects(() => syncMailSafely({ baseUrl: withoutOptIn.baseUrl, accessKey }), { code: 'EXTERNAL_AI_ENABLED' });
  assert.equal(withoutOptIn.requests.some((item) => item.method === 'POST'), false);
});

for (const [name, body, code] of [
  ['without data-policy acceptance', { ...approvedAi, dataPolicyAccepted: false }, 'EXTERNAL_AI_UNAPPROVED'],
  ['with an unknown provider', { ...approvedAi, selectedProvider: 'other-cloud' }, 'EXTERNAL_AI_UNAPPROVED'],
  ['with a missing status flag', { dataPolicyAccepted: true, selectedProvider: 'xai-grok-oauth' }, 'EXTERNAL_AI_ENABLED'],
]) {
  test(`opted-in safe sync still rejects external AI ${name}`, async (t) => {
    const { baseUrl, requests } = await withServer(t, { 'GET /api/ai/oauth/status': { body } });
    await assert.rejects(() => syncMailSafely({ baseUrl, accessKey, allowApprovedExternalAi: true }), { code });
    assert.equal(requests.some((item) => item.method === 'POST'), false);
  });
}

test('safe sync rejects non-delta mode or malformed aggregate before reporting success', async (t) => {
  const wrongMode = await withServer(t, {
    'POST /api/outlook/sync': { body: { connected: true, sync: { mode: 'full-reset', discoveredFolders: 1, completedFolders: 1, failedFolders: 0, attachmentErrors: 0, errors: [], pagesProcessed: 0, fetchedFromGraph: 0, upserted: 0, deleted: 0, totalCached: 0 } } },
  });
  await assert.rejects(() => syncMailSafely({ baseUrl: wrongMode.baseUrl, accessKey }), { code: 'SYNC_INCOMPLETE' });
  const malformed = await withServer(t, {
    'POST /api/outlook/sync': { body: { connected: true, sync: { mode: 'delta', discoveredFolders: 1, completedFolders: 1, failedFolders: 0, attachmentErrors: 0, errors: [], pagesProcessed: 'bad', fetchedFromGraph: 0, upserted: 0, deleted: 0, totalCached: 0 } } },
  });
  await assert.rejects(() => syncMailSafely({ baseUrl: malformed.baseUrl, accessKey }), { code: 'SYNC_INCOMPLETE' });
});

test('safe sync rejects unsafe session without a POST', async (t) => {
  const { baseUrl, requests } = await withServer(t, {
    'GET /api/session': { body: { csrfToken: 'csrf', capabilities: { sendMail: true } } },
  });
  await assert.rejects(() => syncMailSafely({ baseUrl, accessKey }), { code: 'SESSION_UNSAFE' });
  assert.equal(requests.some((item) => item.method === 'POST'), false);
});

const approvedSendCapabilities = {
  mailSend: true,
  mailReadState: false,
  mailMove: false,
  mailDelete: false,
  mailCategory: false,
  calendarWrite: false,
  taskWrite: false,
  dataPlaneWrite: false,
  fixtureWrite: false,
};

function approvedSendHealth(capabilities = approvedSendCapabilities, mode = 'human-approved-mail-send') {
  return {
    ok: true,
    storage: { ready: true },
    externalActionsAllowed: capabilities.mailSend === true,
    safety: {
      mode,
      approved: false,
      capabilities,
    },
    capabilities: {
      send: capabilities.mailSend === true,
      markRead: capabilities.mailReadState === true,
      dataPlane: capabilities.dataPlaneWrite === true,
      externalAi: false,
    },
  };
}

test('safe sync accepts human-approved send health when sync cannot mutate', async (t) => {
  const { baseUrl, requests } = await withServer(t, {
    'GET /api/health': { body: approvedSendHealth() },
    'GET /api/session': { body: { csrfToken: 'csrf', capabilities: { sendMail: true, markRead: false, dataPlane: false } } },
  });
  const result = await syncMailSafely({ baseUrl, accessKey });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(requests.filter((item) => item.method === 'POST').map((item) => item.url), ['/api/outlook/sync']);
});

for (const capability of ['mailReadState', 'mailMove', 'mailDelete', 'mailCategory', 'dataPlaneWrite']) {
  test(`safe sync rejects approved-send health when ${capability} is on`, async (t) => {
    const { baseUrl, requests } = await withServer(t, {
      'GET /api/health': { body: approvedSendHealth({ ...approvedSendCapabilities, [capability]: true }) },
    });
    await assert.rejects(() => syncMailSafely({ baseUrl, accessKey }), { code: 'HEALTH_UNSAFE' });
    assert.equal(requests.some((item) => item.method === 'POST'), false);
  });
}

test('safe sync rejects an unknown safety mode', async (t) => {
  const { baseUrl, requests } = await withServer(t, {
    'GET /api/health': { body: approvedSendHealth(approvedSendCapabilities, 'approved-execution-test') },
  });
  await assert.rejects(() => syncMailSafely({ baseUrl, accessKey }), { code: 'HEALTH_UNSAFE' });
  assert.equal(requests.some((item) => item.method === 'POST'), false);
});

test('safe sync rejects human-approved send mode without a reported capability gate', async (t) => {
  const { baseUrl, requests } = await withServer(t, {
    'GET /api/health': {
      body: {
        ok: true,
        storage: { ready: true },
        externalActionsAllowed: true,
        safety: { mode: 'human-approved-mail-send' },
      },
    },
  });
  await assert.rejects(() => syncMailSafely({ baseUrl, accessKey }), { code: 'HEALTH_UNSAFE' });
  assert.equal(requests.some((item) => item.method === 'POST'), false);
});
