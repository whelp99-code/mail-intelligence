import { chmod, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export const BINDING_FILENAME = '.mail-intake-binding.json';
export const BINDING_VERSION = 1;
export const CANONICAL_GRAPH_ME = 'https://graph.microsoft.com/v1.0/me';
const GENERIC_TENANTS = new Set(['common', 'organizations', 'consumers']);

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function boundedId(value, code, { allowMe = false } = {}) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200 || /\s/u.test(text)) fail(code, 400);
  if (!allowMe && GENERIC_TENANTS.has(text.toLowerCase())) fail(code, 400);
  return text;
}

export function parsePinnedBinding(value) {
  const record = typeof value === 'string' ? JSON.parse(value) : value;
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('INTAKE_BINDING_INVALID', 500);
  if (record.version !== BINDING_VERSION) fail('INTAKE_BINDING_INVALID', 500);
  if (!Number.isInteger(record.revision) || record.revision < 1) fail('INTAKE_BINDING_INVALID', 500);
  const tenantId = boundedId(record.tenantId, 'INTAKE_BINDING_INVALID');
  const principalId = boundedId(record.principalId, 'INTAKE_BINDING_INVALID');
  const mailboxId = boundedId(record.mailboxId, 'INTAKE_BINDING_INVALID');
  const clientId = boundedId(record.clientId, 'INTAKE_BINDING_INVALID');
  const mailboxUser = boundedId(record.mailboxUser, 'INTAKE_BINDING_INVALID', { allowMe: true }).toLowerCase();
  const workspaceId = boundedId(record.workspaceId, 'INTAKE_BINDING_INVALID');
  const intentReference = boundedId(record.intentReference, 'INTAKE_BINDING_INVALID');
  if (mailboxUser !== 'me' && !/^[^@\s]+@[^@\s]+$/.test(mailboxUser)) fail('INTAKE_BINDING_INVALID', 500);
  return {
    version: BINDING_VERSION,
    revision: record.revision,
    workspaceId,
    mailboxUser,
    tenantId,
    principalId,
    mailboxId,
    clientId,
    intentReference,
  };
}

export function samePinnedIdentity(left, right) {
  if (!left || !right) return false;
  return left.workspaceId === right.workspaceId
    && left.mailboxUser === right.mailboxUser
    && left.tenantId === right.tenantId
    && left.principalId === right.principalId
    && left.mailboxId === right.mailboxId
    && left.clientId === right.clientId
    && left.intentReference === right.intentReference;
}

export async function readPinnedBinding(path, readFileImpl) {
  try {
    const raw = await readFileImpl(path, 'utf8');
    return parsePinnedBinding(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'INTAKE_BINDING_INVALID') return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function atomicWritePinnedBinding(path, binding) {
  const record = parsePinnedBinding(binding);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await chmod(temporaryPath, 0o600);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temporaryPath, { force: true });
    throw error;
  }
  try {
    await chmod(path, 0o600);
  } catch {
    // Some filesystems do not support POSIX permissions.
  }
  return record;
}

export function identityEndpointFromEnv(env = {}) {
  const override = String(env.MAIL_INTELLIGENCE_GRAPH_IDENTITY_URL || '').trim();
  if (!override) return CANONICAL_GRAPH_ME;
  let url;
  try {
    url = new URL(override);
  } catch {
    fail('IDENTITY_ENDPOINT_REJECTED', 500);
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('IDENTITY_ENDPOINT_REJECTED', 500);
  if (!loopback || env.MAIL_INTELLIGENCE_ALLOW_LOOPBACK_IDENTITY !== '1') fail('IDENTITY_ENDPOINT_REJECTED', 500);
  return url.toString();
}

export function decodeUnverifiedJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

function identityFields(binding) {
  if (binding.mailboxUser !== 'me' || binding.mailboxId !== binding.principalId) fail('INTAKE_TARGET_UNPROVEN');
  return binding;
}

export async function proveDelegatedIdentity({
  accessToken,
  binding,
  selectedMailbox = 'me',
  endpoint = CANONICAL_GRAPH_ME,
  fetchImpl = globalThis.fetch,
  configuredClientId = '',
  configuredTenantId = '',
  expectedMailboxEmail = null,
} = {}) {
  if (!binding) fail('INTAKE_UNBOUND');
  const expected = identityFields(parsePinnedBinding(binding));
  const selected = String(selectedMailbox || 'me').trim().toLowerCase() || 'me';
  if (selected !== expected.mailboxUser) fail('MAILBOX_NOT_AUTHORIZED');
  if (!accessToken) fail('INTAKE_IDENTITY_UNPROVEN');
  if (configuredClientId && configuredClientId !== expected.clientId) fail('INTAKE_IDENTITY_MISMATCH');
  const configuredTenant = String(configuredTenantId || '').trim();
  if (configuredTenant && !GENERIC_TENANTS.has(configuredTenant.toLowerCase()) && configuredTenant !== expected.tenantId) {
    fail('INTAKE_IDENTITY_MISMATCH');
  }
  const expectedEmail = expectedMailboxEmail === null ? null : String(expectedMailboxEmail).trim().toLowerCase();
  if (expectedEmail !== null && !/^[^@\s]+@[^@\s]+$/.test(expectedEmail)) fail('INTAKE_TARGET_UNPROVEN');
  if (String(endpoint) !== CANONICAL_GRAPH_ME) {
    const url = new URL(endpoint);
    if (!isLoopbackHostname(url.hostname)) fail('IDENTITY_ENDPOINT_REJECTED', 500);
  }
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set('$select', expectedEmail === null ? 'id' : 'id,mail');
  const response = await fetchImpl(requestUrl.toString(), {
    method: 'GET',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response || response.ok !== true) fail('INTAKE_IDENTITY_UNPROVEN');
  let body;
  try {
    body = await response.json();
  } catch {
    fail('INTAKE_IDENTITY_UNPROVEN');
  }
  const graphId = body && typeof body.id === 'string' ? body.id : '';
  if (!graphId) fail('INTAKE_IDENTITY_UNPROVEN');
  if (graphId !== expected.principalId) fail('INTAKE_IDENTITY_MISMATCH');
  if (expectedEmail !== null) {
    const actualEmail = typeof body.mail === 'string' ? body.mail.trim().toLowerCase() : '';
    if (!actualEmail) fail('INTAKE_IDENTITY_UNPROVEN');
    if (actualEmail !== expectedEmail) fail('INTAKE_IDENTITY_MISMATCH');
  }
  const claims = decodeUnverifiedJwtPayload(accessToken);
  if (!claims) fail('INTAKE_IDENTITY_UNPROVEN');
  if (claims.azp && claims.appid && claims.azp !== claims.appid) fail('INTAKE_IDENTITY_UNPROVEN');
  const claimApp = claims.azp || claims.appid || '';
  if (!claims.tid || !claims.oid || !claimApp) fail('INTAKE_IDENTITY_UNPROVEN');
  if (claims.tid !== expected.tenantId || claims.oid !== graphId || claimApp !== expected.clientId) {
    fail('INTAKE_IDENTITY_MISMATCH');
  }
  return {
    accessToken,
    revision: expected.revision,
    tenantId: expected.tenantId,
    principalId: expected.principalId,
    clientId: expected.clientId,
    mailboxId: expected.mailboxId,
  };
}

export function planPinnedRegistration({ current = null, body = null, configuredWorkspaceId = '' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INTAKE_GRANT_EXPLICIT', 400);
  const fields = Object.keys(body);
  const allowed = ['mailboxUser', 'tenantId', 'principalId', 'clientId', 'intentReference'];
  if (fields.length !== allowed.length || allowed.some((key) => typeof body[key] !== 'string')) {
    fail('INTAKE_GRANT_EXPLICIT', 400);
  }
  const workspaceId = String(configuredWorkspaceId || '').trim();
  if (!workspaceId) fail('INTAKE_WORKSPACE_INVALID', 500);
  const proposed = parsePinnedBinding({
    version: BINDING_VERSION,
    revision: current?.revision || 1,
    workspaceId,
    mailboxUser: body.mailboxUser,
    tenantId: body.tenantId,
    principalId: body.principalId,
    mailboxId: body.principalId,
    clientId: body.clientId,
    intentReference: body.intentReference,
  });
  if (current && !samePinnedIdentity({ ...current, revision: proposed.revision }, proposed) && (
    current.tenantId !== proposed.tenantId
    || current.principalId !== proposed.principalId
    || current.clientId !== proposed.clientId
    || current.mailboxUser !== proposed.mailboxUser
  )) {
    fail('INTAKE_ACCOUNT_CHANGE_DENIED');
  }
  if (current && samePinnedIdentity(current, proposed)) return { ...current };
  return { ...proposed, revision: current ? current.revision + 1 : 1 };
}

const INTAKE_DENIAL_CODES = new Set([
  'INTAKE_IDENTITY_MISMATCH',
  'INTAKE_IDENTITY_UNPROVEN',
  'INTAKE_TARGET_UNPROVEN',
  'MAILBOX_NOT_AUTHORIZED',
  'INTAKE_UNBOUND',
  'INTAKE_ACCOUNT_CHANGE_DENIED',
  'IDENTITY_ENDPOINT_REJECTED',
]);

export function intakeDenial(error) {
  return INTAKE_DENIAL_CODES.has(error?.code) ? error : null;
}

export function classifyIdentityFailure(error) {
  if (error?.code === 'INTAKE_BINDING_STALE') return null;
  const denial = intakeDenial(error);
  if (denial) return denial;
  return Object.assign(new Error('INTAKE_IDENTITY_UNPROVEN'), {
    code: 'INTAKE_IDENTITY_UNPROVEN',
    statusCode: 403,
    cause: error,
    transportCode: error?.code || '',
    transportName: error?.name || '',
  });
}

export function refuseObservedRegistration(grant, error) {
  if (grant?.graphIdentityProven && typeof grant.invalidateProof === 'function') {
    grant.invalidateProof();
  }
  throw classifyIdentityFailure(error) || error;
}

export function outlookCallbackFailure(error) {
  const denial = intakeDenial(error);
  if (denial) {
    return {
      statusCode: denial.statusCode || 403,
      code: denial.code,
      title: 'Outlook authorization refused',
    };
  }
  return {
    statusCode: 502,
    code: error?.code || 'MICROSOFT_CODE_EXCHANGE_FAILED',
    title: 'Outlook token exchange failed',
  };
}

export function failClosedIntakeReverify(grant, published) {
  if (!published?.denied) return published ?? null;
  if (grant?.graphIdentityProven && typeof grant.invalidateProof === 'function') {
    grant.invalidateProof();
  }
  const error = published.denied;
  if (!error.statusCode) error.statusCode = 403;
  throw error;
}

// Missing pins stay unbound. A selector or arbitrary token never becomes the pin.
export async function captureVerifiedIntakeSync({
  grant,
  accessToken,
  mailboxUser = 'me',
  reverify,
} = {}) {
  if (!grant?.configured) return null;
  const expected = typeof grant.expectedBinding === 'function' ? grant.expectedBinding() : null;
  const selected = String(mailboxUser || 'me').trim().toLowerCase() || 'me';
  if (expected && selected !== expected.mailboxUser) fail('MAILBOX_NOT_AUTHORIZED');
  const matches = () => Boolean(
    grant.graphIdentityProven
    && grant.authorization().capture().token === accessToken,
  );
  if (!matches()) {
    if (typeof reverify !== 'function') {
      failClosedIntakeReverify(grant, {
        denied: Object.assign(new Error('INTAKE_IDENTITY_UNPROVEN'), { code: 'INTAKE_IDENTITY_UNPROVEN', statusCode: 403 }),
      });
    }
    const published = await reverify(accessToken);
    if (published?.denied) failClosedIntakeReverify(grant, published);
    if (!matches()) {
      failClosedIntakeReverify(grant, {
        denied: Object.assign(new Error('INTAKE_IDENTITY_UNPROVEN'), { code: 'INTAKE_IDENTITY_UNPROVEN', statusCode: 403 }),
      });
    }
  }
  return { authorization: grant.freezeVerified(accessToken) };
}
