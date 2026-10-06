import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMailStore } from '../src/storage/sqlite-store.js';
import { normalizeGraphMessage } from '../src/domain/mail-normalizer.js';
import { syntheticIdentityToken } from './fixtures/synthetic-identity-token.mjs';

const accessKey = 'synthetic-mail-access-key';
const cwosKey = 'synthetic-cwos-key-0123456789abcdef';
const expectedEmail = 'delegate@example.invalid';
const pin = {
  version: 1,
  revision: 1,
  workspaceId: 'synthetic-workspace',
  mailboxUser: 'me',
  tenantId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  mailboxId: '22222222-2222-4222-8222-222222222222',
  clientId: '33333333-3333-4333-8333-333333333333',
  intentReference: 'synthetic-intake-fixture',
};

async function listen(server) {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return `http://127.0.0.1:${server.address().port}`;
}

async function reservePort() {
  const server = createServer();
  const origin = await listen(server);
  const port = Number(new URL(origin).port);
  await closeServer(server);
  return port;
}

function startMail(dataDir, { identityUrl, cwosUrl, graphUrl, port }) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: dataDir,
      PORT: String(port),
      MAIL_INTELLIGENCE_HOST: '127.0.0.1',
      MAIL_INTELLIGENCE_DATA_DIR: dataDir,
      MAIL_INTELLIGENCE_ACCESS_KEY: accessKey,
      MAIL_INTELLIGENCE_PERSIST_SECRETS: '0',
      MAIL_INTELLIGENCE_INTAKE_WORKSPACE: pin.workspaceId,
      MAIL_INTELLIGENCE_INTAKE_EXPECTED_EMAIL: expectedEmail,
      MAIL_INTELLIGENCE_ALLOW_LOOPBACK_IDENTITY: '1',
      MAIL_INTELLIGENCE_GRAPH_IDENTITY_URL: identityUrl,
      MAIL_INTELLIGENCE_CWOS_BASE_URL: cwosUrl,
      MAIL_INTELLIGENCE_CWOS_API_KEY: cwosKey,
      MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID: 'synthetic-mail-reader',
      MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND: 'service',
      MAIL_INTELLIGENCE_CWOS_PLAN_ID: 'synthetic-archive-plan',
      MAIL_INTELLIGENCE_CWOS_TIMEOUT_MS: '5000',
      MAIL_INTELLIGENCE_GRAPH_BASE_URL: graphUrl,
      MICROSOFT_CLIENT_ID: pin.clientId,
      MICROSOFT_TENANT_ID: pin.tenantId,
      OUTLOOK_GRAPH_ACCESS_TOKEN: syntheticIdentityToken(pin),
      MAIL_SEND_RECONCILIATION_INTERVAL_MS: '120000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`readiness timed out: ${stderr.slice(0, 500)}`)), 8000);
    const onExit = () => finish(new Error(`server exited early: ${stderr.slice(0, 500)}`));
    const onData = (chunk) => {
      stdout += chunk;
      const match = stdout.match(/app running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match && stdout.includes('ready.')) finish(null, match[1]);
    };
    const finish = (error, origin) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(origin);
    };
    child.once('exit', onExit);
    child.stdout.on('data', onData);
  });
  return { child, ready };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error('child cleanup timed out')), 3000);
    exited.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  });
  try {
    await Promise.race([exited, timer]);
  } catch {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function openSession(origin) {
  const response = await fetch(`${origin}/api/session`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`mailintelligence:${accessKey}`).toString('base64')}`,
    },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return {
    Cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
    Origin: origin,
    'x-csrf-token': body.csrfToken,
    'Content-Type': 'application/json',
    'x-mail-intelligence-request': '1',
  };
}

test('composed server proves identity, reads CWOS, and blocks tenant mismatch before sync providers', { timeout: 20000 }, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'w06-server-composition-'));
  const identityHits = [];
  const cwosHits = [];
  const graphHits = [];
  let identityMode = 'match';
  const identity = createServer((request, response) => {
    identityHits.push(request.headers.authorization || '');
    const id = pin.principalId;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id,
      mail: identityMode === 'wrong-email' ? 'other@example.invalid' : expectedEmail,
    }));
  });
  const cwos = createServer((request, response) => {
    cwosHits.push(request.url || '');
    assert.equal(request.headers['x-api-key'], cwosKey);
    assert.equal(request.headers['x-workspace-id'], pin.workspaceId);
    assert.equal(request.headers['x-principal-id'], 'synthetic-mail-reader');
    assert.equal(request.headers['x-principal-kind'], 'service');
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/api/cwos/v2/state') {
      response.end(JSON.stringify({
        workspaceId: pin.workspaceId, version: 4, stateHash: 'a'.repeat(64),
        state: {
          workspaceId: pin.workspaceId,
          admin: { workspaces: [{ id: pin.workspaceId, workspaceId: pin.workspaceId, status: 'ACTIVE' }] },
          identity: {
            principals: [{ workspaceId: pin.workspaceId, id: 'synthetic-mail-reader', kind: 'service', active: true }],
            memberships: [{ workspaceId: pin.workspaceId, principalId: 'synthetic-mail-reader', status: 'ACTIVE' }],
          },
          normalizedArchiveRefs: [],
        },
      }));
      return;
    }
    assert.equal(request.url, '/api/cwos/v2/normalized-projections/synthetic-archive-plan');
    response.end(JSON.stringify({
      workspaceId: pin.workspaceId,
      planId: 'synthetic-archive-plan', snapshotId: 'synthetic-archive-snapshot',
      snapshotHash: 'sha256:synthetic', planHash: 'fnv1a32:synthetic',
      sourceObservedAt: '2026-10-06T00:00:00.000Z', planVersion: 1,
      authority: 'ARCHIVE_PROJECTION_ONLY', accounts: [], financialItems: [],
      engagements: [{
        id: 'eng-synthetic',
        workspace_id: pin.workspaceId,
        engagement_type: 'opportunity',
        name: 'Example Project',
        projectKey: 'SYN-1',
        account_id: null,
        account_name: null,
      }],
    }));
  });
  const graph = createServer((request, response) => {
    graphHits.push(request.url || '');
    response.writeHead(200, { 'content-type': 'application/json' });
    if ((request.url || '').includes('/mailFolders') && !(request.url || '').includes('/messages/delta')) {
      response.end(JSON.stringify({
        value: [{ id: 'inbox', displayName: 'Inbox', parentFolderId: '', childFolderCount: 0 }],
      }));
      return;
    }
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    response.end(JSON.stringify({
      value: [{
        id: 'synthetic-mail',
        changeKey: 'source-v2',
        conversationId: 'synthetic-thread',
        internetMessageId: '<synthetic-mail@example.invalid>',
        subject: 'Example Project quote request',
        from: { emailAddress: { address: 'requester@example.invalid' } },
        receivedDateTime: '2026-10-06T00:00:00.000Z',
        isRead: false,
        isDraft: false,
        hasAttachments: false,
        bodyPreview: 'Review the Example Project quote.',
        body: { contentType: 'text', content: 'Review the Example Project quote.' },
        webLink: 'https://outlook.office.com/mail/synthetic-mail',
        parentFolderId: 'inbox',
      }],
      '@odata.deltaLink': `http://${request.headers.host}${url.pathname}?delta=committed`,
    }));
  });
  const identityUrl = await listen(identity);
  const cwosUrl = await listen(cwos);
  const graphUrl = await listen(graph);
  let mail = null;
  t.after(async () => {
    if (mail) await stopChild(mail.child);
    await Promise.all([closeServer(identity), closeServer(cwos), closeServer(graph)]);
    await rm(dataDir, { recursive: true, force: true });
  });

  const store = new SQLiteMailStore({ databasePath: join(dataDir, 'mail-intelligence.sqlite') });
  try {
    const mailbox = store.ensureMailbox({ key: 'me' });
    const folder = store.ensureFolder({ mailboxId: mailbox.id, graphId: 'inbox', wellKnownName: 'inbox' });
    store.applyDeltaPage({
      mailboxId: mailbox.id,
      folderId: folder.id,
      syncRunId: store.startSyncRun({ mailboxId: mailbox.id, folderId: folder.id, runType: 'delta' }),
      pageIndex: 0,
      items: [normalizeGraphMessage({
        id: 'synthetic-mail',
        conversationId: 'synthetic-thread',
        changeKey: 'source-v1',
        subject: 'Example Project quote request',
        from: { emailAddress: { address: 'requester@example.invalid' } },
        receivedDateTime: '2026-10-06T00:00:00.000Z',
        body: { contentType: 'text', content: 'Review the Example Project quote.' },
        webLink: 'https://outlook.office.com/mail/synthetic-mail',
      })],
      deltaLink: `${graphUrl}/v1.0/me/mailFolders/inbox/messages/delta?cursor=fixture`,
    });
  } finally {
    store.close();
  }

  mail = startMail(dataDir, {
    identityUrl: `${identityUrl}/me`,
    cwosUrl,
    graphUrl: `${graphUrl}/v1.0`,
    port: await reservePort(),
  });
  const origin = await mail.ready;
  const headers = await openSession(origin);

  identityMode = 'wrong-email';
  const registrationRequest = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      mailboxUser: pin.mailboxUser,
      tenantId: pin.tenantId,
      principalId: pin.principalId,
      clientId: pin.clientId,
      intentReference: pin.intentReference,
    }),
  };
  const refused = await fetch(`${origin}/api/work-links/intake-grant`, registrationRequest);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'INTAKE_IDENTITY_MISMATCH');
  await assert.rejects(stat(join(dataDir, '.mail-intake-binding.json')), { code: 'ENOENT' });
  assert.equal(identityHits.length, 1);

  identityMode = 'match';
  const registration = await fetch(`${origin}/api/work-links/intake-grant`, registrationRequest);
  const registrationBody = await registration.json();
  assert.equal(registration.status, 200, JSON.stringify(registrationBody));
  assert.equal(registrationBody.graphIdentityProven, true);
  assert.equal(identityHits.length, 2);

  const intake = await fetch(`${origin}/api/work-links/intake?messageId=synthetic-mail&workspaceId=${encodeURIComponent(pin.workspaceId)}`, {
    method: 'POST',
    headers,
  });
  const intakeBody = await intake.json();
  assert.equal(intake.status, 200, JSON.stringify(intakeBody));
  const candidates = intakeBody.project?.candidates || [];
  assert.equal(candidates.length > 0, true);
  const sourceEvidence = candidates.flatMap((candidate) => candidate.evidence || [])
    .filter((item) => ['received_at', 'thread_id', 'source_url'].includes(item.kind))
    .map(({ kind, value }) => ({ kind, value }));
  assert.deepEqual(sourceEvidence, [
    { kind: 'received_at', value: '2026-10-06T00:00:00.000Z' },
    { kind: 'thread_id', value: 'synthetic-thread' },
    { kind: 'source_url', value: 'https://outlook.office.com/mail/synthetic-mail' },
  ]);
  const evidence = candidates.flatMap((candidate) => candidate.evidence || []).find((item) => item.kind === 'cwos_read');
  assert.deepEqual(
    { mailbox: evidence?.mailbox, tenantId: evidence?.tenantId, principalId: evidence?.principalId },
    { mailbox: 'me', tenantId: pin.tenantId, principalId: pin.principalId },
  );
  assert.equal(identityHits.length, 2);
  assert.equal(cwosHits.length, 2);
  assert.deepEqual(graphHits, []);

  await stopChild(mail.child);
  mail = startMail(dataDir, {
    identityUrl: `${identityUrl}/me`,
    cwosUrl,
    graphUrl: `${graphUrl}/v1.0`,
    port: await reservePort(),
  });
  const restartedOrigin = await mail.ready;
  const restartedHeaders = await openSession(restartedOrigin);
  const afterRestart = await fetch(`${restartedOrigin}/api/work-links/intake?messageId=synthetic-mail&workspaceId=${encodeURIComponent(pin.workspaceId)}`, {
    method: 'POST',
    headers: restartedHeaders,
  });
  const afterRestartBody = await afterRestart.json();
  assert.equal(afterRestart.status, 200, JSON.stringify(afterRestartBody));
  assert.equal(identityHits.length, 3);
  assert.equal(cwosHits.length, 4);
  assert.deepEqual(
    (afterRestartBody.project?.candidates || []).map((candidate) => candidate.external_id),
    candidates.map((candidate) => candidate.external_id),
  );
  const restartedEvidence = (afterRestartBody.project?.candidates || [])
    .flatMap((candidate) => candidate.evidence || [])
    .find((item) => item.kind === 'cwos_read');
  assert.deepEqual(
    { mailbox: restartedEvidence?.mailbox, tenantId: restartedEvidence?.tenantId, principalId: restartedEvidence?.principalId },
    { mailbox: 'me', tenantId: pin.tenantId, principalId: pin.principalId },
  );
  const restartedSourceEvidence = (afterRestartBody.project?.candidates || [])
    .flatMap((candidate) => candidate.evidence || [])
    .filter((item) => ['received_at', 'thread_id', 'source_url'].includes(item.kind))
    .map(({ kind, value }) => ({ kind, value }));
  assert.deepEqual(restartedSourceEvidence, sourceEvidence);
  assert.deepEqual((afterRestartBody.project?.candidates || []).map((candidate) => candidate.external_id), candidates.map((candidate) => candidate.external_id));

  const committedSync = await fetch(`${restartedOrigin}/api/outlook/sync`, {
    method: 'POST',
    headers: restartedHeaders,
    body: JSON.stringify({ top: 1 }),
  });
  const committedSyncBody = await committedSync.json();
  assert.equal(committedSync.status, 200, JSON.stringify(committedSyncBody));
  assert.equal(committedSyncBody.connected, true);
  assert.equal(committedSyncBody.sync.upserted >= 1, true);
  assert.equal(graphHits.length > 0, true);
  assert.equal(cwosHits.length, 6);
  const syncedProjectionResponse = await fetch(`${restartedOrigin}/api/work-links/intake?messageId=synthetic-mail`, {
    headers: { Cookie: restartedHeaders.Cookie },
  });
  const syncedProjection = await syncedProjectionResponse.json();
  assert.equal(syncedProjectionResponse.status, 200, JSON.stringify(syncedProjection));
  const syncedEvidence = (syncedProjection.project?.candidates || [])
    .flatMap((candidate) => candidate.evidence || [])
    .find((item) => item.kind === 'cwos_read');
  assert.deepEqual(
    { mailbox: syncedEvidence?.mailbox, tenantId: syncedEvidence?.tenantId, principalId: syncedEvidence?.principalId },
    { mailbox: 'me', tenantId: pin.tenantId, principalId: pin.principalId },
  );
  const syncedSourceEvidence = (syncedProjection.project?.candidates || [])
    .flatMap((candidate) => candidate.evidence || [])
    .filter((item) => ['received_at', 'thread_id', 'source_url'].includes(item.kind))
    .map(({ kind, value }) => ({ kind, value }));
  assert.deepEqual(syncedSourceEvidence, sourceEvidence);

  const changedTenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const config = await fetch(`${restartedOrigin}/api/outlook/config`, {
    method: 'POST',
    headers: restartedHeaders,
    body: JSON.stringify({
      accessToken: syntheticIdentityToken(pin),
      clientId: pin.clientId,
      tenantId: changedTenant,
      aiProvider: 'rules',
      persist: false,
    }),
  });
  const configBody = await config.json();
  assert.equal(config.status, 403, JSON.stringify(configBody));
  assert.equal(configBody.code, 'INTAKE_IDENTITY_MISMATCH');
  const identityBeforeDeniedSync = identityHits.length;
  const graphBeforeDeniedSync = graphHits.length;
  assert.equal(cwosHits.length, 6);

  const sync = await fetch(`${restartedOrigin}/api/outlook/sync`, {
    method: 'POST',
    headers: restartedHeaders,
    body: JSON.stringify({ top: 1 }),
  });
  const syncBody = await sync.json();
  assert.equal(sync.status, 200, JSON.stringify(syncBody));
  assert.equal(syncBody.connected, false);
  assert.equal(syncBody.mode, 'offline-cache');
  assert.equal(syncBody.sync.errorCode, 'INTAKE_IDENTITY_MISMATCH');
  assert.equal(syncBody.messages.length, 1);
  assert.equal(identityHits.length, identityBeforeDeniedSync);
  assert.equal(graphHits.length, graphBeforeDeniedSync);
  assert.equal(cwosHits.length, 6);
});
