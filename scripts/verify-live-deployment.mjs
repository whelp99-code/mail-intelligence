#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const baseUrl = String(process.env.MAIL_INTELLIGENCE_BASE_URL || 'http://127.0.0.1:3010').replace(/\/$/, '');
const accessKeyPath = process.env.MAIL_INTELLIGENCE_ACCESS_KEY_FILE
  || new URL('../data/.mail-intelligence-access-key', import.meta.url);
const accessKey = (await readFile(accessKeyPath, 'utf8')).trim();
assert.match(accessKey, /^[A-Za-z0-9_-]{40,}$/);

async function jsonResponse(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    cache: 'no-store',
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const health = await jsonResponse('/api/health');
assert.equal(health.response.status, 200);
assert.equal(health.body.ok, true);
assert.equal(health.body.version, '1.2.2');
assert.equal(health.body.precisionClassificationVersion, 'precision-classification-v1.2.2-fix10');
assert.equal(health.body.intelligentSearchVersion, 'intelligent-search-v1.2.2');
assert.equal(health.body.outlookOAuthRedirectUri, 'http://localhost:3010/auth/callback');
assert.equal(health.body.listenHost, '127.0.0.1');
assert.equal(health.body.safety?.mode, 'read-only');
assert.equal(health.body.externalActionsAllowed, false);
assert.equal(health.body.storage?.authoritativeStore, 'sqlite');
assert.equal(health.body.storage?.schemaVersion, 4);
assert.equal(health.body.storage?.ready, true);
assert.ok(health.body.graphConsent?.includes('Mail.Read'));
assert.equal(health.body.graphConsent?.includes('Mail.Send'), false);
assert.equal(health.body.graphConsent?.includes('Mail.ReadWrite'), false);

const unauthenticatedRoot = await fetch(`${baseUrl}/`, { redirect: 'manual' });
assert.equal(unauthenticatedRoot.status, 401);
assert.match(unauthenticatedRoot.headers.get('www-authenticate') || '', /Mail Intelligence/);

const authorization = `Basic ${Buffer.from(`mailintelligence:${accessKey}`, 'utf8').toString('base64')}`;
const authenticatedRoot = await fetch(`${baseUrl}/`, {
  redirect: 'manual',
  headers: { Authorization: authorization },
});
assert.equal(authenticatedRoot.status, 200);
const html = await authenticatedRoot.text();
assert.match(html, /v1\.2\.2 · Operational Classification/);
assert.match(html, /프로젝트는 자동 생성하지 않습니다/);
assert.match(html, /http:\/\/localhost:3010\/auth\/callback/);
const mailWorkspaceIndex = html.indexOf('id="mailShell"');
const precisionIndex = html.indexOf('id="precisionIntelligence"');
const memoryIndex = html.indexOf('id="persistentMemory"');
const settingsIndex = html.indexOf('id="configForm"');
assert.ok(mailWorkspaceIndex > 0);
assert.ok(mailWorkspaceIndex < precisionIndex);
assert.ok(precisionIndex < memoryIndex);
assert.ok(memoryIndex < settingsIndex);
assert.equal((html.match(/class="col-resizer"/g) || []).length, 2);
assert.equal((html.match(/role="separator"/g) || []).length, 2);
assert.match(html, /연결·분석 설정/);
assert.match(html, /class="config-section config-section-outlook" open/);
const cookie = (authenticatedRoot.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^mi_session=/);

const appSourceResponse = await fetch(`${baseUrl}/app.js`, { headers: { Cookie: cookie } });
assert.equal(appSourceResponse.status, 200);
const appSource = await appSourceResponse.text();
assert.match(appSource, /X-Mail-Intelligence-Request/);

const session = await jsonResponse('/api/session', { headers: { Cookie: cookie } });
assert.equal(session.response.status, 200);
assert.ok(session.body.csrfToken);
assert.deepEqual(session.body.capabilities, { sendMail: false, markRead: false, dataPlane: false });

const readHeaders = { Cookie: cookie };
const mutationHeaders = {
  Cookie: cookie,
  Origin: baseUrl,
  'Content-Type': 'application/json',
  'X-CSRF-Token': session.body.csrfToken,
  'X-Mail-Intelligence-Request': '1',
};

const outlookStatus = await jsonResponse('/api/outlook/status', { headers: readHeaders });
assert.equal(outlookStatus.response.status, 200);
assert.equal(outlookStatus.body.safety?.mode, 'read-only');
assert.equal(outlookStatus.body.storage?.authoritativeStore, 'sqlite');

const config = await jsonResponse('/api/outlook/config', { headers: readHeaders });
assert.equal(config.response.status, 200);
const oauthStart = await jsonResponse('/api/outlook/oauth/start', {
  method: 'POST',
  headers: mutationHeaders,
  body: JSON.stringify({
    clientId: config.body.clientId || 'redirect-contract-client',
    tenantId: config.body.loginTenant || 'common',
    mailboxUser: config.body.mailboxUser || '',
  }),
});
assert.equal(oauthStart.response.status, 200, JSON.stringify(oauthStart.body));
const authorizeUrl = new URL(oauthStart.body.authorizeUrl);
const authorizationRedirectUri = authorizeUrl.searchParams.get('redirect_uri') || '';
const authorizationScopes = (authorizeUrl.searchParams.get('scope') || '').split(/\s+/).filter(Boolean);
assert.equal(authorizeUrl.protocol, 'https:');
assert.equal(authorizeUrl.hostname, 'login.microsoftonline.com');
assert.equal(authorizationRedirectUri, 'http://localhost:3010/auth/callback');
assert.equal(authorizationRedirectUri.includes('127.0.0.1'), false);
assert.ok(authorizationScopes.includes('Mail.Read'));
assert.equal(authorizationScopes.includes('Mail.Send'), false);
assert.equal(authorizationScopes.includes('Mail.ReadWrite'), false);
const configSave = await jsonResponse('/api/outlook/config', {
  method: 'POST',
  headers: mutationHeaders,
  body: JSON.stringify({
    aiProvider: config.body.aiProvider || 'rules',
    openaiCodexModel: config.body.openaiCodexModel || 'luna',
    xaiGrokModel: config.body.xaiGrokModel || 'grok-4.6',
    aiDataPolicyAccepted: config.body.aiProvider !== 'rules' && config.body.aiOptedIn === true,
    persist: false,
  }),
});
assert.equal(configSave.response.status, 200, JSON.stringify(configSave.body));
assert.equal(configSave.body.aiProvider, config.body.aiProvider || 'rules');

const storage = await jsonResponse('/api/storage/status', { headers: readHeaders });
assert.equal(storage.response.status, 200);
assert.equal(storage.body.authoritativeStore, 'sqlite');
assert.equal(storage.body.schemaVersion, 4);
assert.equal(storage.body.ready, true);

const oauthProviders = await jsonResponse('/api/ai/oauth/status', { headers: readHeaders });
assert.equal(oauthProviders.response.status, 200, JSON.stringify(oauthProviders.body));
assert.equal(oauthProviders.body.providerVersion, 'oauth-cli-provider-v1.2.2');
assert.ok(Array.isArray(oauthProviders.body.providers));
assert.ok(oauthProviders.body.providers.some((provider) => provider.provider === 'openai-codex-oauth'));
assert.ok(oauthProviders.body.providers.some((provider) => provider.provider === 'xai-grok-oauth'));
assert.equal(JSON.stringify(oauthProviders.body).includes('access_token'), false);
assert.equal(JSON.stringify(oauthProviders.body).includes('refresh_token'), false);

const classificationRun = await jsonResponse('/api/intelligence/classify', {
  method: 'POST',
  headers: mutationHeaders,
  body: JSON.stringify({ force: false }),
});
assert.equal(classificationRun.response.status, 200, JSON.stringify(classificationRun.body));
assert.ok(Number.isInteger(classificationRun.body.processed));

const precisionSummary = await jsonResponse('/api/intelligence/summary', { headers: readHeaders });
assert.equal(precisionSummary.response.status, 200, JSON.stringify(precisionSummary.body));
assert.equal(precisionSummary.body.total, storage.body.counts?.precision_classifications || 0);
assert.ok(precisionSummary.body.states);

const projects = await jsonResponse('/api/intelligence/projects', { headers: readHeaders });
assert.equal(projects.response.status, 200, JSON.stringify(projects.body));
assert.ok(Array.isArray(projects.body.projects));

const smartViews = await jsonResponse('/api/intelligence/smart-views', { headers: readHeaders });
assert.equal(smartViews.response.status, 200, JSON.stringify(smartViews.body));
assert.ok(smartViews.body.views?.some((view) => view.id === 'review-required'));

const search = await jsonResponse(`/api/intelligence/search?q=${encodeURIComponent('분류 불확실')}&limit=10`, { headers: readHeaders });
assert.equal(search.response.status, 200);
assert.ok(Array.isArray(search.body.results));
assert.ok(search.body.parsedQuery?.filters);

const analyze = await jsonResponse('/api/outlook/analyze?top=10', { headers: readHeaders });
assert.equal(analyze.response.status, 200, JSON.stringify(analyze.body));
assert.ok(Array.isArray(analyze.body.messages));

const sync = await jsonResponse('/api/outlook/sync', {
  method: 'POST',
  headers: mutationHeaders,
  body: JSON.stringify({ top: 10 }),
});
assert.equal(sync.response.status, 200, JSON.stringify(sync.body));
assert.ok(Array.isArray(sync.body.messages));

const backup = await jsonResponse('/api/storage/backup', {
  method: 'POST',
  headers: mutationHeaders,
  body: '{}',
});
assert.equal(backup.response.status, 201, JSON.stringify(backup.body));
assert.equal(backup.body.created, true);
assert.equal(backup.body.backup?.schemaVersion, 4);
assert.equal(backup.body.backup?.integrity, true);
assert.match(backup.body.backup?.checksumSha256 || '', /^[a-f0-9]{64}$/);

const blockedSend = await jsonResponse('/api/outlook/send', {
  method: 'POST',
  headers: mutationHeaders,
  body: JSON.stringify({ to: 'nobody@example.invalid', subject: 'blocked', body: 'blocked' }),
});
assert.equal(blockedSend.response.status, 403);
assert.equal(blockedSend.body.code, 'EXTERNAL_ACTION_DISABLED');

const finalStorage = await jsonResponse('/api/storage/status', { headers: readHeaders });
assert.equal(finalStorage.response.status, 200);
assert.ok((finalStorage.body.counts?.backup_manifests || 0) >= 1);

console.log(JSON.stringify({
  deployment: 'PASS',
  baseUrl,
  version: health.body.version,
  precisionClassificationVersion: health.body.precisionClassificationVersion,
  intelligentSearchVersion: health.body.intelligentSearchVersion,
  outlookOAuthRedirectUri: health.body.outlookOAuthRedirectUri,
  authorizationRedirectUri,
  authorizationScopes,
  layoutContract: 'mail-workspace-first-five-track-v1',
  service: health.body.service,
  listenHost: health.body.listenHost,
  safetyMode: health.body.safety.mode,
  graphConsent: health.body.graphConsent,
  secretStorage: health.body.secretStorage,
  sqlite: {
    authoritativeStore: finalStorage.body.authoritativeStore,
    schemaVersion: finalStorage.body.schemaVersion,
    ready: finalStorage.body.ready,
    integrity: finalStorage.body.integrity,
    messages: finalStorage.body.counts?.messages || 0,
    folders: finalStorage.body.counts?.mail_folders || 0,
    backups: finalStorage.body.counts?.backup_manifests || 0,
    precisionClassifications: finalStorage.body.counts?.precision_classifications || 0,
    precisionCorrections: finalStorage.body.counts?.precision_corrections || 0,
    projects: finalStorage.body.counts?.projects || 0,
  },
  precision: {
    total: precisionSummary.body.total,
    reviewRequired: precisionSummary.body.reviewRequired,
    corrected: precisionSummary.body.corrected,
    smartViews: smartViews.body.views.length,
    intelligentSearchResults: search.body.results.length,
  },
  oauthProviders: oauthProviders.body.providers.map((provider) => ({
    provider: provider.provider,
    installed: provider.installed,
    authenticated: provider.authenticated,
    authMode: provider.authMode,
    version: provider.version,
  })),
  externalAiEnabled: oauthProviders.body.externalAiEnabled,
  outlookConfigured: Boolean(outlookStatus.body.connected),
  offlineAnalyzeMessages: analyze.body.messages.length,
  offlineSyncMessages: sync.body.messages.length,
  externalSendBlocked: true,
}, null, 2));
