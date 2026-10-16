import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NEW_ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{40,}$/;
export const DEFAULT_ACCESS_USERNAME = 'mailintelligence';

export function envAssignment(text, name) {
  for (const line of String(text ?? '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    return line.slice(eq + 1).replace(/\r$/, '');
  }
  return undefined;
}

function usable(value) {
  return value != null && !value.includes('\n') && !value.includes('\r') && value.trim() !== '';
}

export function newAccessKey() {
  return randomBytes(32).toString('base64url');
}

/**
 * Keep a non-empty login id and access key already stored in runtime.env.
 * The shape check applies only when a key has to be created.
 */
export function resolveRuntimeAccess({
  existingText = '',
  keyFileText = '',
  generateKey = newAccessKey,
} = {}) {
  const existingUser = envAssignment(existingText, 'MAIL_INTELLIGENCE_ACCESS_USER');
  const existingKey = envAssignment(existingText, 'MAIL_INTELLIGENCE_ACCESS_KEY');
  const username = usable(existingUser) ? existingUser.trim() : DEFAULT_ACCESS_USERNAME;
  if (usable(existingKey)) {
    return { username, accessKey: existingKey, createdKey: false };
  }
  const fromFile = usable(keyFileText) ? keyFileText.trim() : '';
  const accessKey = fromFile || String(generateKey() || '');
  if (!NEW_ACCESS_KEY_PATTERN.test(accessKey)) {
    throw Object.assign(new Error('Access key failed validation.'), { code: 'ACCESS_KEY_INVALID' });
  }
  return { username, accessKey, createdKey: !fromFile };
}

export function renderRuntimeEnv({ dataDir, accessUser, accessKey, allowedProxyHosts = '' }) {
  return [
    'NODE_ENV=production',
    'HOST=127.0.0.1',
    'PORT=3010',
    `MAIL_INTELLIGENCE_DATA_DIR=${dataDir}`,
    `MAIL_INTELLIGENCE_ACCESS_USER=${accessUser}`,
    `MAIL_INTELLIGENCE_ACCESS_KEY=${accessKey}`,
    'MAIL_INTELLIGENCE_PERSIST_SECRETS=1',
    'MAIL_INTELLIGENCE_ACTIONS_APPROVED=0',
    'MAIL_INTELLIGENCE_ALLOW_SEND=0',
    'MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0',
    'MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0',
    'MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0',
    `MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS=${allowedProxyHosts}`,
    '',
  ].join('\n');
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function writeRuntimeAccessEnv({
  dataDir,
  allowedProxyHosts = '',
  generateKey = newAccessKey,
} = {}) {
  if (!dataDir) throw Object.assign(new Error('data dir is required.'), { code: 'DATA_DIR_REQUIRED' });
  const runtimePath = join(dataDir, 'runtime.env');
  const keyPath = join(dataDir, '.mail-intelligence-access-key');
  const resolved = resolveRuntimeAccess({
    existingText: await readOptional(runtimePath),
    keyFileText: await readOptional(keyPath),
    generateKey,
  });
  if (resolved.createdKey) {
    await writeFile(keyPath, resolved.accessKey, { mode: 0o600 });
    await chmod(keyPath, 0o600);
  }
  const body = renderRuntimeEnv({
    dataDir,
    accessUser: resolved.username,
    accessKey: resolved.accessKey,
    allowedProxyHosts,
  });
  const tmp = `${runtimePath}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, runtimePath);
  await chmod(runtimePath, 0o600);
  return { username: resolved.username };
}
