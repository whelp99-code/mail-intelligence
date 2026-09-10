import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export const SERVICE_TOKEN_HEADER = 'x-mail-intelligence-service-token';
export const MIN_SERVICE_TOKEN_LENGTH = 32;
export const SERVICE_SCOPES = Object.freeze({
  read: 'read',
  draftCreate: 'draft-create',
});

const TRUE_EMPTY = '';

function normalizeToken(value) {
  return String(value || '').trim();
}

function readTokenFile(filePath) {
  const path = normalizeToken(filePath);
  if (!path || !existsSync(path)) return TRUE_EMPTY;
  try {
    return normalizeToken(readFileSync(path, 'utf8'));
  } catch {
    return TRUE_EMPTY;
  }
}

function tokenFromEnv(env, name) {
  const direct = normalizeToken(env[`MAIL_INTELLIGENCE_${name}`]);
  if (direct) return direct;
  return readTokenFile(env[`MAIL_INTELLIGENCE_${name}_FILE`]);
}

export function constantTimeTokenEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function isUsableServiceToken(value) {
  const token = normalizeToken(value);
  return token.length >= MIN_SERVICE_TOKEN_LENGTH && !/[\r\n\0]/.test(token);
}

export function loadServiceTokens(env = process.env) {
  const draftToken = tokenFromEnv(env, 'GROK_DRAFT_TOKEN');
  const serviceToken = tokenFromEnv(env, 'GROK_SERVICE_TOKEN');
  const principals = [];

  if (isUsableServiceToken(draftToken)) {
    principals.push(Object.freeze({
      id: 'grok-draft',
      source: 'grok-bot',
      token: draftToken,
      scopes: Object.freeze([SERVICE_SCOPES.read, SERVICE_SCOPES.draftCreate]),
    }));
  }

  if (isUsableServiceToken(serviceToken) && !constantTimeTokenEquals(serviceToken, draftToken)) {
    principals.push(Object.freeze({
      id: 'grok-service',
      source: 'grok-bot',
      token: serviceToken,
      scopes: Object.freeze([SERVICE_SCOPES.read]),
    }));
  }

  return Object.freeze({
    configured: principals.length > 0,
    principals: Object.freeze(principals),
  });
}

export function extractPresentedServiceToken(headers = {}) {
  const dedicated = normalizeToken(headers[SERVICE_TOKEN_HEADER] || headers[SERVICE_TOKEN_HEADER.toUpperCase()]);
  if (dedicated) return dedicated;
  const authorization = String(headers.authorization || headers.Authorization || '');
  if (/^Bearer\s+/i.test(authorization)) {
    return normalizeToken(authorization.replace(/^Bearer\s+/i, ''));
  }
  return TRUE_EMPTY;
}

export function matchServicePrincipal(presentedToken, catalog = loadServiceTokens()) {
  const token = normalizeToken(presentedToken);
  if (!token || !catalog.configured) return null;
  for (const principal of catalog.principals) {
    if (constantTimeTokenEquals(token, principal.token)) {
      return {
        id: principal.id,
        source: principal.source,
        scopes: principal.scopes,
      };
    }
  }
  return null;
}

export function servicePrincipalFromHeaders(headers = {}, catalog = loadServiceTokens()) {
  const presented = extractPresentedServiceToken(headers);
  if (!presented) return null;
  return matchServicePrincipal(presented, catalog);
}

export function hasServiceScope(principal, scope) {
  return Boolean(principal?.scopes?.includes(scope));
}

export function publicServiceAuthStatus(catalog = loadServiceTokens()) {
  return {
    serviceTokensConfigured: catalog.configured,
    draftCreateEnabled: catalog.principals.some((item) => item.scopes.includes(SERVICE_SCOPES.draftCreate)),
    readEnabled: catalog.principals.some((item) => item.scopes.includes(SERVICE_SCOPES.read)),
  };
}
