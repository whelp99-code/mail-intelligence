import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

function fail(code, statusCode) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

// A single instance-scoped binding, independent of browser and draft authority.
export async function loadJarvisMailReader(env = {}, { forbiddenCredentials = [] } = {}) {
  const enabled = env.MAIL_INTELLIGENCE_JARVIS_READER_ENABLED;
  const principalId = String(env.MAIL_INTELLIGENCE_JARVIS_READER_PRINCIPAL_ID || '').trim();
  const keyFile = String(env.MAIL_INTELLIGENCE_JARVIS_READER_KEY_FILE || '').trim();
  if (enabled === '0' || (!enabled && !principalId && !keyFile)) return null;
  if (enabled !== '1' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principalId)
    || !isAbsolute(keyFile)) fail('JARVIS_READER_CONFIG_INVALID', 500);

  let file;
  let credential;
  try {
    file = await open(keyFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600
      || metadata.uid !== process.getuid() || metadata.size > 4098) {
      fail('JARVIS_READER_CONFIG_INVALID', 500);
    }
    credential = (await file.readFile('utf8')).trim();
  } catch {
    fail('JARVIS_READER_CONFIG_INVALID', 500);
  } finally {
    await file?.close();
  }
  if (!/^[\x21-\x7e]{32,4096}$/.test(credential)) fail('JARVIS_READER_CONFIG_INVALID', 500);
  const credentialDigest = digest(credential);
  if (forbiddenCredentials.some(value => value && timingSafeEqual(digest(value), credentialDigest))) {
    fail('JARVIS_READER_CREDENTIAL_REUSE', 500);
  }
  return Object.freeze({ principalId, credentialDigest });
}

// Run before every route, including session issuance, OAuth and static content.
// A machine-auth attempt never falls back to a human cookie or another token.
export function authorizeJarvisMailReader(req, binding) {
  const headers = req.headers;
  const fields = ['x-api-key', 'x-principal-id', 'x-principal-kind', 'x-workspace-id'];
  if (!fields.some(field => Object.hasOwn(headers, field))) return false;
  if (!binding || typeof headers['x-api-key'] !== 'string'
    || headers['x-principal-id'] !== binding.principalId
    || headers['x-principal-kind'] !== 'service'
    || !timingSafeEqual(digest(headers['x-api-key']), binding.credentialDigest)) {
    fail('JARVIS_READER_UNAUTHENTICATED', 401);
  }
  if (Object.hasOwn(headers, 'cookie') || Object.hasOwn(headers, 'authorization')
    || Object.hasOwn(headers, 'x-workspace-id')) fail('JARVIS_READER_AUTH_CONFLICT', 403);
  if (req.method !== 'GET' || req.url !== '/api/storage/status') {
    fail('JARVIS_READER_SCOPE_DENIED', 403);
  }
  return true;
}
