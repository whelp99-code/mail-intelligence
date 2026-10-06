/**
 * Read-only client for native CWOS v2 state and archive projections.
 * Two GETs are not an atomic snapshot. Workspace, actor, plan and credential
 * come only from the explicit binding, never from a request or another process.
 */

import { mailSourceDigest } from './cwos-mail-command.js';

const STATE_ROUTE = '/api/cwos/v2/state';

function fail(code, message = code, statusCode = 502) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function assertWorkspaceId(value) {
  const workspace = String(value || '').trim();
  if (!workspace || workspace.length > 200 || /\s/u.test(workspace)) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  if ([...workspace].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  })) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  return workspace;
}

function assertCredential(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 4096 || /\s/u.test(value)) {
    fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  }
  return value;
}

function assertBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  return url.origin;
}

function boundedTimeoutMs(value) {
  if (value == null || value === '') return 10_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 50 || parsed > 120_000) {
    fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  }
  return parsed;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function requiredId(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /\s/u.test(value) || hasControlCharacter(value)) {
    fail('CWOS_RESPONSE_INVALID');
  }
  return value;
}

function requiredLabel(value) {
  if (typeof value !== 'string') fail('CWOS_RESPONSE_INVALID');
  const text = value.trim();
  if (!text || text.length > 500 || hasControlCharacter(text)) fail('CWOS_RESPONSE_INVALID');
  return text;
}

function optionalLabel(value) {
  if (value == null || value === '') return '';
  return requiredLabel(value);
}

function accountType(kinds) {
  if (Array.isArray(kinds)) return kinds.map((item) => requiredLabel(item)).join(',');
  if (kinds == null || kinds === '') return '';
  if (typeof kinds !== 'string') fail('CWOS_RESPONSE_INVALID');
  const text = kinds.trim();
  if (!text) return '';
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('CWOS_RESPONSE_INVALID');
    }
    if (!Array.isArray(parsed)) fail('CWOS_RESPONSE_INVALID');
    return parsed.map((item) => requiredLabel(item)).join(',');
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return text.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean).map((item) => requiredLabel(item)).join(',');
  }
  return requiredLabel(text);
}

export function cwosMasterReaderConfigFromEnv(env = {}) {
  const baseUrl = String(env.MAIL_INTELLIGENCE_CWOS_BASE_URL || '').trim();
  const credential = String(env.MAIL_INTELLIGENCE_CWOS_API_KEY || '');
  const credentialFile = String(env.MAIL_INTELLIGENCE_CWOS_API_KEY_FILE || '').trim();
  const principalId = env.MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID;
  const kind = env.MAIL_INTELLIGENCE_CWOS_PRINCIPAL_KIND;
  const planId = env.MAIL_INTELLIGENCE_CWOS_PLAN_ID;
  if (!baseUrl && !credential && !credentialFile && !principalId && !kind && !planId
    && env.MAIL_INTELLIGENCE_CWOS_TIMEOUT_MS == null) return null;
  if (!baseUrl || (!credential && !credentialFile)) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  if (!['ai', 'service'].includes(kind)) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
  return {
    baseUrl: assertBaseUrl(baseUrl),
    credential: credentialFile ? '' : assertCredential(credential),
    credentialFile,
    workspaceId: assertWorkspaceId(env.MAIL_INTELLIGENCE_INTAKE_WORKSPACE),
    principalId: assertWorkspaceId(principalId),
    kind,
    planId: assertWorkspaceId(planId),
    timeoutMs: boundedTimeoutMs(env.MAIL_INTELLIGENCE_CWOS_TIMEOUT_MS),
  };
}

export async function loadCwosMasterReader(env = {}, {
  fetchImpl = globalThis.fetch,
  readFileImpl,
  statImpl,
} = {}) {
  const config = cwosMasterReaderConfigFromEnv(env);
  if (!config) return null;
  let credential = config.credential;
  if (config.credentialFile) {
    const readFile = readFileImpl || (await import('node:fs/promises')).readFile;
    const stat = statImpl || (await import('node:fs/promises')).stat;
    const metadata = await stat(config.credentialFile);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      fail('CWOS_READER_CONFIG_INVALID', 'CWOS credential file must be private.', 500);
    }
    credential = assertCredential(String(await readFile(config.credentialFile, 'utf8')).trim());
  }
  return new CwosMasterReader({ ...config, credential, fetchImpl });
}

export class CwosMasterReader {
  constructor({ baseUrl, credential, workspaceId, principalId, kind, planId, timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
    if (!['ai', 'service'].includes(kind)) fail('CWOS_READER_CONFIG_INVALID', 'CWOS_READER_CONFIG_INVALID', 500);
    this.origin = assertBaseUrl(baseUrl);
    this.credential = assertCredential(credential);
    this.workspaceId = assertWorkspaceId(workspaceId);
    this.principalId = assertWorkspaceId(principalId);
    this.kind = kind;
    this.planId = assertWorkspaceId(planId);
    this.timeoutMs = boundedTimeoutMs(timeoutMs);
    this.fetchImpl = fetchImpl;
  }

  async readMasters({ workspaceId = '', principalId = this.principalId, cursor = '' } = {}) {
    if (cursor) fail('CWOS_MASTERS_INCOMPLETE', 'CWOS_MASTERS_INCOMPLETE', 409);
    if (workspaceId !== this.workspaceId) fail('CWOS_WORKSPACE_NOT_BOUND', 'CWOS_WORKSPACE_NOT_BOUND', 403);
    if (principalId !== this.principalId) fail('CWOS_PRINCIPAL_NOT_BOUND', 'CWOS_PRINCIPAL_NOT_BOUND', 403);
    const envelope = await this.#getJson(STATE_ROUTE);
    this.#assertTrustedWorkspace(envelope);
    this.#assertTrustedWorkspace(envelope?.state);
    const identity = envelope?.state?.identity;
    const workspaces = envelope?.state?.admin?.workspaces;
    if (!Number.isSafeInteger(envelope?.version) || envelope.version < 0
      || !/^[a-f0-9]{64}$/.test(envelope?.stateHash || '')
      || !Array.isArray(identity?.principals) || !Array.isArray(identity?.memberships)
      || !Array.isArray(workspaces)) fail('CWOS_RESPONSE_INVALID');
    if (!identity.principals.some(item => item.id === this.principalId && item.kind === this.kind
      && item.workspaceId === this.workspaceId && item.active === true)
      || !identity.memberships.some(item => item.principalId === this.principalId
        && item.workspaceId === this.workspaceId && item.status === 'ACTIVE')
      || !workspaces.some(item => item.id === this.workspaceId && item.workspaceId === this.workspaceId
        && item.status === 'ACTIVE')) fail('CWOS_RESPONSE_SCOPE_MISMATCH');
    const route = `/api/cwos/v2/normalized-projections/${encodeURIComponent(this.planId)}`;
    const projectionReadAt = new Date().toISOString();
    const projection = await this.#getJson(route);
    this.#assertTrustedWorkspace(projection);
    if (projection.planId !== this.planId || projection.authority !== 'ARCHIVE_PROJECTION_ONLY'
      || !Number.isSafeInteger(projection.planVersion) || projection.planVersion < 1
      || !Number.isFinite(Date.parse(projection.sourceObservedAt))
      || !Array.isArray(projection.accounts) || !Array.isArray(projection.engagements)
      || !Array.isArray(projection.financialItems)) fail('CWOS_RESPONSE_INVALID');
    requiredId(projection.snapshotId);
    requiredId(projection.snapshotHash);
    requiredId(projection.planHash);
    const sourceDigest = mailSourceDigest(projection);
    const references = envelope.state.normalizedArchiveRefs ?? [];
    if (!Array.isArray(references)) fail('CWOS_RESPONSE_INVALID');
    for (const reference of references.filter(item => item.planId === this.planId)) {
      if (reference.workspaceId !== this.workspaceId || reference.approved !== false
        || !Number.isSafeInteger(reference.planVersion) || reference.planVersion > projection.planVersion) {
        fail('CWOS_ARCHIVE_REFERENCE_MISMATCH');
      }
      if (reference.planVersion < projection.planVersion) continue;
      if (reference.snapshotHash !== projection.snapshotHash || reference.planHash !== projection.planHash
        || reference.sourceDigest !== sourceDigest) {
        fail('CWOS_ARCHIVE_REFERENCE_MISMATCH');
      }
    }
    const source = {
      route, planId: this.planId, snapshotId: projection.snapshotId,
      snapshotHash: projection.snapshotHash, planHash: projection.planHash,
      planVersion: projection.planVersion, sourceObservedAt: projection.sourceObservedAt, sourceDigest,
      authority: projection.authority, recordKind: 'ARCHIVE_REFERENCES',
      approved: false, confirmed: false, nativeWork: false,
    };
    const accounts = this.#mapAccounts(projection.accounts, source);
    const engagements = this.#mapEngagements(projection.engagements, accounts, source);
    return {
      workspaceId: this.workspaceId,
      items: [...accounts, ...engagements],
      provenance: {
        provider: 'cwos',
        atomicSnapshot: false,
        contract: 'cwos-v2',
        routes: [STATE_ROUTE, route],
        accountsReadAt: projectionReadAt,
        engagementsReadAt: projectionReadAt,
        principalId: this.principalId, principalKind: this.kind,
        runtimeVersion: envelope.version, stateHash: envelope.stateHash,
        ...source,
      },
    };
  }

  #assertTrustedWorkspace(payload) {
    if (!payload || (payload.workspaceId ?? payload.workspace_id) !== this.workspaceId
      || (payload.workspaceId != null && payload.workspaceId !== this.workspaceId)
      || (payload.workspace_id != null && payload.workspace_id !== this.workspaceId)) fail('CWOS_RESPONSE_SCOPE_MISMATCH');
  }

  #mapAccounts(rows, source) {
    const seenIds = new Set();
    return rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('CWOS_RESPONSE_INVALID');
      this.#assertTrustedWorkspace(row);
      const externalId = requiredId(row.id);
      if (seenIds.has(externalId)) fail('CWOS_RESPONSE_INVALID');
      seenIds.add(externalId);
      const name = requiredLabel(row.name);
      const type = accountType(row.kinds);
      const status = optionalLabel(row.status);
      return {
        objectType: 'account',
        externalId,
        name,
        type,
        status: 'candidate',
        approved: false,
        nativeWork: false,
        system: 'cwos',
        source: {
          system: 'cwos',
          ...source,
          id: externalId,
          name,
          type,
          status: status || null,
          kinds: row.kinds ?? null,
        },
      };
    });
  }

  #mapEngagements(rows, accounts, source) {
    const byId = new Map(accounts.map((account) => [account.externalId, account]));
    const byName = new Map();
    for (const account of accounts) {
      const matches = byName.get(account.name) || [];
      matches.push(account);
      byName.set(account.name, matches);
    }
    const seenIds = new Set();
    return rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('CWOS_RESPONSE_INVALID');
      this.#assertTrustedWorkspace(row);
      const externalId = requiredId(row.id);
      if (seenIds.has(externalId)) fail('CWOS_RESPONSE_INVALID');
      seenIds.add(externalId);
      const name = requiredLabel(row.name);
      const type = requiredLabel(row.engagement_type);
      const stage = optionalLabel(row.stage);
      const projectKey = optionalLabel(row.projectKey ?? row.project_key);
      const relatedAccount = this.#relatedAccount(row, byId, byName);
      return {
        objectType: 'engagement',
        externalId,
        name,
        type,
        stage,
        projectKey,
        relatedAccount,
        system: 'cwos',
        status: 'candidate',
        approved: false,
        nativeWork: false,
        source: {
          system: 'cwos',
          ...source,
          id: externalId,
          name,
          type: row.engagement_type,
          stage: row.stage ?? null,
          sourceStage: row.source_stage ?? null,
          projectKey: row.projectKey ?? row.project_key ?? null,
          accountName: row.account_name ?? null,
          accountId: row.account_id ?? null,
          relatedAccountId: relatedAccount?.externalId || null,
        },
      };
    });
  }

  #relatedAccount(row, byId, byName) {
    const accountId = row.account_id == null || row.account_id === '' ? '' : requiredId(row.account_id);
    const accountName = row.account_name == null || row.account_name === '' ? '' : requiredLabel(row.account_name);
    if (!accountId && !accountName) return null;
    const byIdentifier = accountId ? byId.get(accountId) : null;
    if (accountId && !byIdentifier) fail('CWOS_REFERENCE_INCONSISTENT');
    const named = accountName ? (byName.get(accountName) || []) : [];
    if (accountName && named.length !== 1) fail('CWOS_REFERENCE_INCONSISTENT');
    if (byIdentifier && named.length === 1 && named[0] !== byIdentifier) fail('CWOS_REFERENCE_INCONSISTENT');
    const account = byIdentifier || named[0];
    return { externalId: account.externalId, name: account.name };
  }

  async #getJson(pathname) {
    const target = new URL(pathname, `${this.origin}/`);
    let response;
    try {
      response = await this.fetchImpl(target, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'x-api-key': this.credential,
          'x-workspace-id': this.workspaceId,
          'x-principal-id': this.principalId,
          'x-principal-kind': this.kind,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error?.code?.startsWith?.('CWOS_')) throw error;
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') fail('CWOS_TIMEOUT', 'CWOS_TIMEOUT', 504);
      fail('CWOS_PROVIDER_UNAVAILABLE');
    }
    if (response.status >= 300 && response.status < 400) fail('CWOS_CREDENTIAL_REDIRECT');
    try {
      const finalUrl = new URL(response.url || target);
      if (finalUrl.origin !== this.origin) fail('CWOS_CREDENTIAL_REDIRECT');
    } catch {
      fail('CWOS_CREDENTIAL_REDIRECT');
    }
    if (response.status === 401 || response.status === 403) fail('CWOS_UNAUTHENTICATED');
    if (response.status !== 200) fail('CWOS_PROVIDER_HTTP');
    try {
      return await response.json();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.cause?.name === 'TimeoutError' || error?.cause?.name === 'AbortError') {
        fail('CWOS_TIMEOUT', 'CWOS_TIMEOUT', 504);
      }
      fail('CWOS_RESPONSE_INVALID');
    }
  }
}
