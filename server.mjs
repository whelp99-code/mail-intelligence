import { createServer } from 'node:http';
import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStaticFile } from './src/security/static-path.js';
import { parseTailnetAllowedHosts } from './src/security/tcp-allowlist-proxy.js';
import {
  AI_PIPELINE_VERSION,
  buildAnalysisCacheKey,
  extractJsonObject,
  failedAiRun,
  policyBlockedAiRun,
  parseAiAnalysis,
  providerModel
} from './src/ai-contract.js';
import { withAiResilience } from './src/ai/resilience.js';
import {
  OAUTH_CLI_PROVIDER_VERSION,
  oauthCliProviderStatus,
  oauthProviderLoginInstructions,
  runOAuthCliProvider,
  shouldRecordOAuthProviderFailure,
} from './src/ai/oauth-cli-provider.js';
import { analyzeMessages } from './src/analyzer.js';
import { PersistentMailMemoryRuntime } from './src/application/persistent-mail-memory.js';
import { PRECISION_CLASSIFICATION_VERSION } from './src/domain/precision-classifier.js';
import { INTELLIGENT_SEARCH_VERSION } from './src/domain/intelligent-search.js';
import { OPERATIONAL_CLASSIFICATION_VERSION } from './src/domain/operational-classification.js';
import { MAIL_ASSISTANT_TOOLS_VERSION } from './src/domain/mail-assistant-tools.js';
import {
  assertMutationAllowed,
  delegatedScopesForSafety,
  getSafetyPolicy,
  normalizeLoopbackHost,
  normalizePort,
  publicSafetyStatus
} from './src/safety.js';
import { APP_VERSION } from './src/version.js';

const root = fileURLToPath(new URL('./src', import.meta.url));
const appRoot = dirname(fileURLToPath(import.meta.url));
const configuredDataRoot = String(process.env.MAIL_INTELLIGENCE_DATA_DIR || '').trim();
const configuredLegacyDataRoot = String(process.env.MAIL_INTELLIGENCE_LEGACY_DATA_DIR || '').trim();
const dataRoot = configuredDataRoot
  ? isAbsolute(configuredDataRoot)
    ? configuredDataRoot
    : resolve(appRoot, configuredDataRoot)
  : join(appRoot, 'data');
const legacyDataRoot = configuredLegacyDataRoot
  ? isAbsolute(configuredLegacyDataRoot)
    ? configuredLegacyDataRoot
    : resolve(appRoot, configuredLegacyDataRoot)
  : appRoot;
const legacyFallbackEnabled = Boolean(configuredLegacyDataRoot || !configuredDataRoot);
const configPath = join(dataRoot, '.outlook-config.json');
const mailCachePath = join(dataRoot, '.mail-cache.json');
const databasePath = join(dataRoot, 'mail-intelligence.sqlite');
const backupDirectory = join(dataRoot, 'backups');
const secretPath = join(dataRoot, '.outlook-secrets.enc.json');
const keyPath = join(dataRoot, '.mail-intelligence.key');
const legacyConfigPath = legacyFallbackEnabled ? join(legacyDataRoot, '.outlook-config.json') : '';
const legacyMailCachePath = legacyFallbackEnabled ? join(legacyDataRoot, '.mail-cache.json') : '';
const port = normalizePort(process.env.PORT || 3010);
const host = normalizeLoopbackHost(process.env.HOST || process.env.MAIL_INTELLIGENCE_HOST || '127.0.0.1');
const localBaseUrl = host === '::1' ? `http://[::1]:${port}` : `http://${host}:${port}`;
const allowedProxyHosts = new Set(parseTailnetAllowedHosts(
  process.env.MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS || '',
));
const graphBaseUrl = String(process.env.MAIL_INTELLIGENCE_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const safetyPolicy = getSafetyPolicy(process.env);
const delegatedScopes = delegatedScopesForSafety(safetyPolicy);
const configuredAccessKey = String(process.env.MAIL_INTELLIGENCE_ACCESS_KEY || '').trim();
const accessKeyRequired = configuredAccessKey.length > 0;
const AI_OPT_IN_VERSION = 'ai-oauth-opt-in-v1.2.2';
const AI_PROMPT_VERSION = 'mail-intelligence-v1.2.2-oauth-prompt-1';
const MAX_JSON_BODY_BYTES = 256 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_LOCAL_SESSIONS = 128;
const MAX_PENDING_OAUTH_STATES = 128;
const FEEDBACK_STATUSES = new Set(['urgent', 'active', 'waiting', 'done', 'reference']);
const FEEDBACK_REASONS = {
  urgent: '마감/장애/고객 리스크',
  active: '우리가 처리해야 할 작업 있음',
  waiting: '상대방 회신/승인/자료 필요',
  done: '이미 처리/발송/종료됨',
  reference: '참고용이며 후속 업무 없음',
  hold: '보류: 지금 처리하지 않고 추후 확인'
};
const FEEDBACK_REASON_CODES = new Set(Object.keys(FEEDBACK_REASONS));
const DEFAULT_RUNTIME_CONFIG = Object.freeze({
  accessToken: '',
  tenantId: '',
  clientId: '',
  clientSecret: '',
  mailboxUser: '',
  loginTenant: 'common',
  refreshToken: '',
  expiresAt: 0,
  aiProvider: 'rules',
  openaiCodexModel: 'luna',
  xaiGrokModel: 'grok-4.6',
  domainProfile: 'generic',
  domainProfiles: '',
  aiOptInVersion: ''
});
const PERSISTED_CONFIG_KEYS = new Set([
  'tenantId',
  'clientId',
  'mailboxUser',
  'loginTenant',
  'aiProvider',
  'openaiCodexModel',
  'xaiGrokModel',
  'domainProfile',
  'domainProfiles',
  'aiOptInVersion'
]);
const runtimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
const pendingOAuth = new Map();
const localSessions = new Map();
let mailMemory = null;
let mailMemoryHealth = {
  ready: false,
  schemaVersion: 0,
  sizeBytes: 0,
};

async function readPrimaryOrLegacy(primaryPath, legacyPath) {
  try {
    return { raw: await readFile(primaryPath, 'utf8'), sourcePath: primaryPath, legacy: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!legacyPath || legacyPath === primaryPath) return null;
  try {
    return { raw: await readFile(legacyPath, 'utf8'), sourcePath: legacyPath, legacy: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function retireLegacyRuntimeFile(filePath, label) {
  if (!filePath) return;
  try {
    await unlink(filePath);
    console.warn(`[storage] Migrated legacy ${label} into ${dataRoot}.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[storage] Legacy ${label} was migrated but could not be removed: ${error.message}`);
    }
  }
}

async function ensurePrivateDirectory(directoryPath) {
  const created = await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  if (created) {
    try {
      await chmod(directoryPath, 0o700);
    } catch {
      // Some filesystems do not support chmod; creation mode remains restrictive where supported.
    }
    return;
  }
  const metadata = await stat(directoryPath);
  if (!metadata.isDirectory()) {
    const error = new Error(`Runtime data path is not a directory: ${directoryPath}`);
    error.code = 'DATA_DIRECTORY_INVALID';
    throw error;
  }
  const mode = metadata.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const error = new Error(`Runtime data directory must be owner-only (0700): ${directoryPath}`);
    error.code = 'DATA_DIRECTORY_PERMISSIONS_UNSAFE';
    throw error;
  }
}

const SECRET_CONFIG_KEYS = new Set(['accessToken', 'refreshToken', 'clientSecret', 'expiresAt']);
const LEGACY_SECRET_CONFIG_KEYS = new Set(['geminiApiKey']);
const ALL_SECRET_CONFIG_KEYS = new Set([...SECRET_CONFIG_KEYS, ...LEGACY_SECRET_CONFIG_KEYS]);
const LEGACY_AI_CONFIG_KEYS = new Set([
  'geminiModel',
  'faiosServerUrl',
  'lmstudioServerUrl',
  'lmstudioModel',
]);

function shouldPersistSecrets() {
  return accessKeyRequired && String(process.env.MAIL_INTELLIGENCE_PERSIST_SECRETS || '1') !== '0';
}

async function atomicWriteJson(targetPath, value, mode = 0o600) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode
    });
    try {
      await chmod(temporaryPath, mode);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
    await rename(temporaryPath, targetPath);
    try {
      await chmod(targetPath, mode);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw error;
  }
}

async function loadEncryptionKey({ createIfMissing = true } = {}) {
  const configured = String(process.env.MAIL_INTELLIGENCE_MASTER_KEY || '').trim();
  if (configured) return createHash('sha256').update(configured, 'utf8').digest();

  try {
    const encoded = (await readFile(keyPath, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('Local encryption key must be 32 bytes.');
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!createIfMissing) {
      const missing = new Error('Local encryption key is missing.');
      missing.code = 'ENCRYPTION_KEY_MISSING';
      throw missing;
    }
  }

  const key = randomBytes(32);
  try {
    await writeFile(keyPath, `${key.toString('base64')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    try {
      await chmod(keyPath, 0o600);
    } catch {
      // Some filesystems do not support POSIX permissions.
    }
    return key;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const encoded = (await readFile(keyPath, 'utf8')).trim();
    const existing = Buffer.from(encoded, 'base64');
    if (existing.length !== 32) throw new Error('Local encryption key must be 32 bytes.');
    return existing;
  }
}

async function encryptSecrets(secrets) {
  const key = await loadEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(secrets), 'utf8'),
    cipher.final()
  ]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

async function decryptSecrets(envelope) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted secret envelope.');
  }
  const key = await loadEncryptionKey({ createIfMissing: false });
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const ciphertext = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Encrypted secret envelope fields are invalid.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Encrypted secret payload must be an object.');
  }
  return parsed;
}

function parseJsonObject(raw, label, code) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`${label} contains invalid JSON.`);
    error.code = code;
    error.cause = cause;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error(`${label} must be a JSON object.`);
    error.code = code;
    throw error;
  }
  return parsed;
}

function secretValuesFrom(source = {}) {
  const secrets = {};
  for (const key of SECRET_CONFIG_KEYS) {
    const value = source[key];
    if (key === 'expiresAt') {
      if (Number.isFinite(value) && value > 0) secrets[key] = value;
    } else if (typeof value === 'string' && value) {
      secrets[key] = value;
    }
  }
  return secrets;
}

async function readEncryptedSecrets() {
  let raw;
  try {
    raw = await readFile(secretPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const envelope = parseJsonObject(raw, 'Encrypted secrets file', 'SECRETS_INVALID');
    return await decryptSecrets(envelope);
  } catch (cause) {
    const error = new Error('Encrypted secrets are unreadable or invalid.');
    error.code = 'SECRETS_INVALID';
    error.cause = cause;
    throw error;
  }
}

async function savePersistedConfig(sourceConfig = runtimeConfig) {
  const publicConfig = Object.fromEntries(
    [...PERSISTED_CONFIG_KEYS].map((key) => [key, sourceConfig[key] ?? DEFAULT_RUNTIME_CONFIG[key]])
  );
  await atomicWriteJson(configPath, publicConfig);

  if (!shouldPersistSecrets()) {
    try {
      await unlink(secretPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }

  const secrets = secretValuesFrom(sourceConfig);
  if (Object.keys(secrets).length === 0) {
    try {
      await unlink(secretPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  }
  await atomicWriteJson(secretPath, await encryptSecrets(secrets));
}

async function loadPersistedConfig() {
  const record = await readPrimaryOrLegacy(configPath, legacyConfigPath);
  let legacySecretsFound = false;
  let legacyAiDefault = false;

  if (record) {
    let parsed;
    try {
      parsed = parseJsonObject(record.raw, 'Persisted Outlook configuration', 'CONFIG_INVALID');
    } catch (cause) {
      const error = new Error('Public configuration is unreadable or invalid.');
      error.code = 'CONFIG_INVALID';
      error.cause = cause;
      throw error;
    }
    const publicInput = { ...parsed };
    const plaintextSecrets = {};
    for (const key of ALL_SECRET_CONFIG_KEYS) {
      if (Object.hasOwn(parsed, key)) {
        if (SECRET_CONFIG_KEYS.has(key)) plaintextSecrets[key] = parsed[key];
        delete publicInput[key];
        if (parsed[key]) legacySecretsFound = true;
      }
    }
    for (const key of LEGACY_AI_CONFIG_KEYS) {
      if (Object.hasOwn(publicInput, key)) {
        delete publicInput[key];
        legacyAiDefault = true;
      }
    }

    const legacyProvider = ['f-aios-v3', 'lmstudio', 'gemini'].includes(String(publicInput.aiProvider || ''));
    if (legacyProvider) {
      publicInput.aiProvider = 'rules';
      publicInput.aiOptInVersion = '';
    }
    const loaded = validatedPublicConfig(publicInput, runtimeConfig);
    const unapprovedExternalProvider = loaded.aiProvider !== 'rules'
      && loaded.aiOptInVersion !== AI_OPT_IN_VERSION;
    legacyAiDefault = record.legacy || legacyProvider || unapprovedExternalProvider;
    if (unapprovedExternalProvider) {
      loaded.aiProvider = 'rules';
      loaded.aiOptInVersion = '';
    }
    Object.assign(runtimeConfig, loaded);
    for (const key of SECRET_CONFIG_KEYS) {
      const value = plaintextSecrets[key];
      if (key === 'expiresAt' && Number.isFinite(value)) runtimeConfig[key] = value;
      if (key !== 'expiresAt' && typeof value === 'string') runtimeConfig[key] = value;
    }

    if (record.legacy || legacySecretsFound || legacyAiDefault) {
      await savePersistedConfig(runtimeConfig);
      if (record.legacy) await retireLegacyRuntimeFile(record.sourcePath, 'configuration');
      console.warn('[security] Migrated legacy configuration to the v1.2.2 operational-classification baseline.');
    }
  }

  const encryptedSecrets = await readEncryptedSecrets();
  for (const key of SECRET_CONFIG_KEYS) {
    const value = encryptedSecrets[key];
    if (key === 'expiresAt' && Number.isFinite(value)) runtimeConfig[key] = value;
    if (key !== 'expiresAt' && typeof value === 'string') runtimeConfig[key] = value;
  }
}


function requireMailMemory() {
  if (!mailMemory) throw new Error('Persistent mail memory is not initialized.');
  return mailMemory;
}

function mailboxCacheKey(mailboxUser) {
  return (mailboxUser || 'me').toLowerCase();
}

function currentMailboxKey() {
  return mailboxCacheKey(getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER'));
}

function currentMailboxUser() {
  return getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER');
}

function emailAddress(value = '') {
  return String(value).match(/<([^>]+)>/)?.[1]?.trim() || String(value).trim();
}

function compactText(value = '', max = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function subjectTokens(subject = '') {
  return compactText(subject, 200)
    .toLowerCase()
    .replace(/[()[\]{}<>,.;:!?'"`~@#$%^&*_+=|\\/]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function feedbackForPrompt(feedback = {}) {
  return Object.values(feedback)
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
    .slice(0, 30)
    .map((item) => ({
      sender: item.sender || '',
      subjectHint: compactText(item.subject || '', 80),
      subjectTokens: item.subjectTokens || [],
      userStatus: item.userStatus,
      reason: FEEDBACK_REASONS[item.reasonCode] || item.reasonCode || '',
      note: compactText(item.note || '', 120)
    }));
}

function feedbackSimilarity(message, feedbackItem) {
  let score = 0;
  const sender = emailAddress(message.from || '').toLowerCase();
  if (sender && sender === String(feedbackItem.sender || '').toLowerCase()) score += 2;
  const currentTokens = new Set(subjectTokens(message.subject));
  for (const token of feedbackItem.subjectTokens || []) {
    if (currentTokens.has(String(token).toLowerCase())) score += 1;
  }
  const text = `${message.subject || ''} ${message.bodyPreview || ''} ${message.body || ''}`.toLowerCase();
  if (feedbackItem.reasonCode === 'waiting' && /승인|회신|자료|대기|확인\s*부탁|pending|waiting/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'urgent' && /긴급|마감|오늘|금일|장애|critical|asap/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'done' && /완료|발송|처리|종료|resolved|completed|done/.test(text)) score += 2;
  if (feedbackItem.reasonCode === 'active' && /진행|검토|준비|공유|작성|review|follow/.test(text)) score += 1;
  return score;
}

function inferredFeedbackStatus(message, feedback = {}) {
  const candidates = Object.values(feedback)
    .filter((item) => FEEDBACK_STATUSES.has(item.userStatus))
    .map((item) => ({ item, score: feedbackSimilarity(message, item) }))
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'default-src \'self\'; base-uri \'none\'; frame-ancestors \'none\'; form-action \'self\'; object-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'self\'',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
}

function json(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function constantTimeEquals(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf('=');
        if (separator < 0) return [item, ''];
        return [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
      })
  );
}

function trimOldestEntry(map, maximum) {
  while (map.size >= maximum) {
    const oldest = map.keys().next().value;
    if (oldest == null) return;
    map.delete(oldest);
  }
}

function pruneLocalSessions() {
  const now = Date.now();
  for (const [token, session] of localSessions) {
    if (!session || now - session.createdAt > SESSION_TTL_MS) localSessions.delete(token);
  }
}

function prunePendingOAuth() {
  const now = Date.now();
  for (const [state, item] of pendingOAuth) {
    if (!item || now - item.createdAt > OAUTH_STATE_TTL_MS) pendingOAuth.delete(state);
  }
}

function createLocalSession(res) {
  pruneLocalSessions();
  trimOldestEntry(localSessions, MAX_LOCAL_SESSIONS);
  const token = base64Url(randomBytes(32));
  const session = {
    token,
    csrfToken: base64Url(randomBytes(24)),
    createdAt: Date.now()
  };
  localSessions.set(token, session);
  res.setHeader(
    'Set-Cookie',
    `mi_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
  return session;
}

function sessionForRequest(req) {
  pruneLocalSessions();
  const token = parseCookies(req.headers.cookie || '').mi_session || '';
  return token ? localSessions.get(token) || null : null;
}

function validBasicAccess(req) {
  if (!accessKeyRequired) return true;
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return username === 'mailintelligence' && constantTimeEquals(password, configuredAccessKey);
}

function writeBasicChallenge(res) {
  const body = 'Mail Intelligence access key required.';
  res.writeHead(401, {
    ...securityHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'WWW-Authenticate': 'Basic realm="Mail Intelligence", charset="UTF-8"'
  });
  res.end(body);
}

function requirePageAccess(req, res) {
  if (!accessKeyRequired) return true;
  if (sessionForRequest(req)) return true;
  if (!validBasicAccess(req)) {
    writeBasicChallenge(res);
    return false;
  }
  createLocalSession(res);
  return true;
}

function requireSessionCookie(req) {
  const session = sessionForRequest(req);
  if (session) return session;
  throw new HttpError(
    401,
    accessKeyRequired ? 'ACCESS_REQUIRED' : 'SESSION_REQUIRED',
    accessKeyRequired ? 'Mail Intelligence access is required.' : 'A local browser session is required.'
  );
}

function sessionCapabilities() {
  return {
    sendMail: Boolean(safetyPolicy.capabilities?.mailSend),
    markRead: Boolean(safetyPolicy.capabilities?.mailReadState),
    dataPlane: Boolean(safetyPolicy.capabilities?.dataPlaneWrite)
  };
}

function publicCapabilities() {
  return {
    send: Boolean(safetyPolicy.capabilities?.mailSend),
    markRead: Boolean(safetyPolicy.capabilities?.mailReadState),
    dataPlane: Boolean(safetyPolicy.capabilities?.dataPlaneWrite),
    externalAi: String(process.env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI || '') === '1'
  };
}

function issueLocalSession(req, res) {
  let session = sessionForRequest(req);
  if (!session) {
    if (accessKeyRequired && !validBasicAccess(req)) {
      throw new HttpError(401, 'ACCESS_REQUIRED', 'Mail Intelligence access is required.');
    }
    session = createLocalSession(res);
  }
  json(res, 200, {
    csrfToken: session.csrfToken,
    expiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
    capabilities: sessionCapabilities()
  });
}

function expectedOrigin(req) {
  try {
    return new URL(`http://${req.headers.host || `127.0.0.1:${port}`}`).origin;
  } catch {
    return localBaseUrl;
  }
}

function assertAllowedHost(req) {
  const rawHost = String(req.headers.host || '').trim();
  if (!rawHost) throw new HttpError(400, 'HOST_REQUIRED', 'Host header is required.');
  let parsed;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    throw new HttpError(400, 'HOST_INVALID', 'Host header is invalid.');
  }
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', ...allowedProxyHosts]);
  if (!allowed.has(parsed.hostname)) {
    throw new HttpError(403, 'HOST_REJECTED', 'Only the local Mail Intelligence origin is allowed.');
  }
}

function requireStateChange(req) {
  const session = requireSessionCookie(req);
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new HttpError(403, 'ORIGIN_REJECTED', 'Request origin is invalid.');
    }
    if (normalized !== expectedOrigin(req)) {
      throw new HttpError(403, 'ORIGIN_REJECTED', 'Cross-origin state changes are not allowed.');
    }
  }

  if (accessKeyRequired) {
    if (String(req.headers['x-mail-intelligence-request'] || '') !== '1') {
      throw new HttpError(403, 'MUTATION_PROTECTION_REQUIRED', 'Mutation protection header is required.');
    }
  } else if (!constantTimeEquals(req.headers['x-csrf-token'], session.csrfToken)) {
    throw new HttpError(403, 'CSRF_REQUIRED', 'A valid CSRF token is required.');
  }
  return session;
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'CONTENT_TYPE_REQUIRED', 'State-changing requests must use application/json.');
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, 'REQUEST_TOO_LARGE', 'JSON request body is too large.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, 'REQUEST_TOO_LARGE', 'JSON request body is too large.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object.');
    }
    return parsed;
  } catch (cause) {
    throw new HttpError(400, 'JSON_INVALID', cause.message || 'JSON request body is invalid.');
  }
}

function assertCapability(_policy, capability) {
  if (capability === 'externalAi' && String(process.env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI || '') !== '1') {
    throw new HttpError(403, 'EXTERNAL_AI_DISABLED', 'External AI transmission is disabled by policy.');
  }
}

function escapeHtmlServer(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function hasControlCharacters(value) {
  return [...String(value ?? '')].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function validatedText(value, field, maximumLength = 500) {
  const text = String(value ?? '').trim();
  if (text.length > maximumLength) {
    throw new HttpError(400, 'CONFIG_VALUE_TOO_LONG', `${field} exceeds ${maximumLength} characters.`);
  }
  if (hasControlCharacters(text)) {
    throw new HttpError(400, 'CONFIG_VALUE_INVALID', `${field} contains control characters.`);
  }
  return text;
}

function validateTenantIdentifier(value) {
  const text = validatedText(value, 'tenantId', 253);
  if (!text) return '';
  if (!/^(?:common|organizations|consumers|[A-Za-z0-9.-]+)$/.test(text)) {
    throw new HttpError(400, 'TENANT_ID_INVALID', 'Tenant ID must be a tenant GUID, verified domain, or supported Microsoft tenant alias.');
  }
  return text;
}

function validateClientIdentifier(value) {
  const text = validatedText(value, 'clientId', 100);
  if (!text) return '';
  if (!/^[A-Za-z0-9-]+$/.test(text)) {
    throw new HttpError(400, 'CLIENT_ID_INVALID', 'Client ID contains unsupported characters.');
  }
  return text;
}

function validateMailboxUser(value) {
  const text = validatedText(value, 'mailboxUser', 320);
  if (!text) return '';
  if (!/^[^\s@]+@[^\s@]+$/.test(text)) {
    throw new HttpError(400, 'MAILBOX_USER_INVALID', 'Mailbox User must be a valid email-style user principal name.');
  }
  return text;
}

function validateDomainProfiles(value) {
  const text = validatedText(value, 'domainProfiles', 500);
  if (!text) return '';
  const profiles = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (profiles.length > 20 || profiles.some((item) => !/^[A-Za-z0-9._-]{1,50}$/.test(item))) {
    throw new HttpError(400, 'DOMAIN_PROFILES_INVALID', 'Domain profiles must be comma-separated identifiers using letters, numbers, dot, underscore, or hyphen.');
  }
  return [...new Set(profiles.map((item) => item.toLowerCase()))].join(',');
}

function validatedModelIdentifier(value, field, fallback = '') {
  const model = validatedText(value, field, 120) || fallback;
  if (!model) return '';
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new HttpError(400, 'AI_MODEL_INVALID', `${field} contains unsupported characters.`);
  }
  return model;
}

function oauthCliConfiguredPath(provider) {
  return provider === 'openai-codex-oauth'
    ? String(process.env.MAIL_INTELLIGENCE_CODEX_BIN || '').trim()
    : String(process.env.MAIL_INTELLIGENCE_GROK_BIN || '').trim();
}

async function oauthProviderStatus(provider) {
  return await oauthCliProviderStatus(provider, {
    configuredPath: oauthCliConfiguredPath(provider),
    cwd: appRoot,
  });
}

function safeProviderFailure(error) {
  const raw = `${error?.code || ''} ${error instanceof Error ? error.message : ''}`.toLowerCase();
  if (/external_ai_disabled|external_ai_opt_in_required/.test(raw)) {
    return {
      safeErrorCode: 'EXTERNAL_AI_POLICY_BLOCKED',
      message: '외부 AI 분석이 현재 운영 정책으로 비활성화되어 Rules 결과를 사용합니다.',
      userAction: '실제 모델 분석이 필요할 때만 운영자 승인과 데이터 정책 동의를 활성화하세요.',
      retryable: false,
    };
  }
  if (/402|balance exhausted|usage balance|insufficient (?:credit|fund)/i.test(raw)) {
    return {
      safeErrorCode: 'BILLING_BALANCE_EXHAUSTED',
      message: '공급자 사용 잔액이 소진되어 실제 모델 호출을 완료하지 못했습니다.',
      userAction: '공급자 결제·사용 잔액을 확인한 후 다시 테스트하세요.',
      retryable: false,
    };
  }
  if (/not authenticated|login required|credential|401|403/i.test(raw)) {
    return {
      safeErrorCode: 'OAUTH_RELOGIN_REQUIRED',
      message: 'OAuth 로그인이 만료되었거나 사용할 수 없습니다.',
      userAction: '공식 CLI에서 다시 로그인한 후 상태를 새로고침하세요.',
      retryable: false,
    };
  }
  if (/timeout|timed out|408/.test(raw)) {
    return {
      safeErrorCode: 'PROVIDER_TIMEOUT',
      message: '모델 응답 시간이 초과되었습니다.',
      userAction: '잠시 후 다시 테스트하세요. 반복되면 공급자 상태를 확인하세요.',
      retryable: true,
    };
  }
  if (/429|rate limit|too many requests/.test(raw)) {
    return {
      safeErrorCode: 'PROVIDER_RATE_LIMITED',
      message: '공급자 호출 한도에 도달했습니다.',
      userAction: '잠시 기다린 후 다시 테스트하세요.',
      retryable: true,
    };
  }
  if (/tool_use_rejected|unsafe tool|tool event/.test(raw)) {
    return {
      safeErrorCode: 'PROVIDER_UNSAFE_TOOL_EVENT',
      message: '모델이 허용되지 않은 도구 실행을 시도해 결과를 차단했습니다.',
      userAction: 'Rules 결과를 사용하고 운영 로그를 검토하세요.',
      retryable: false,
    };
  }
  if (/json|schema|invalid response|empty final/.test(raw)) {
    return {
      safeErrorCode: 'PROVIDER_INVALID_RESPONSE',
      message: '모델 응답이 Mail Intelligence 검증 계약을 충족하지 못했습니다.',
      userAction: 'Rules 결과를 사용하고 다시 테스트하세요.',
      retryable: true,
    };
  }
  if (/\b5\d\d\b|temporar|unavailable/.test(raw)) {
    return {
      safeErrorCode: 'PROVIDER_TEMPORARILY_UNAVAILABLE',
      message: '공급자 서비스가 일시적으로 응답하지 않습니다.',
      userAction: '잠시 후 다시 테스트하세요.',
      retryable: true,
    };
  }
  return {
    safeErrorCode: 'PROVIDER_CALL_FAILED',
    message: '실제 모델 호출을 완료하지 못했습니다.',
    userAction: 'OAuth 상태와 공급자 서비스를 확인한 후 다시 테스트하세요.',
    retryable: true,
  };
}

function recordProviderRuntimeEvent(eventType, provider, payload) {
  return mailMemory?.store?.audit(eventType, {
    entityType: 'oauth_provider',
    entityId: provider,
    payload,
  }) || null;
}

function latestProviderRuntimeEvent(eventType, provider) {
  return mailMemory?.store?.latestAuditEvent(eventType, {
    entityType: 'oauth_provider',
    entityId: provider,
  })?.payload || null;
}

async function oauthProviderStatuses() {
  const statuses = await Promise.all([
    oauthProviderStatus('openai-codex-oauth'),
    oauthProviderStatus('xai-grok-oauth'),
  ]);
  return statuses.map((status) => {
    const lastSyntheticTest = latestProviderRuntimeEvent('oauth.provider.synthetic_test', status.provider) || {
      status: 'never', testedAt: null, latencyMs: null, safeErrorCode: '', userAction: '',
    };
    const lastRealMailAnalysis = latestProviderRuntimeEvent('oauth.provider.real_mail_analysis', status.provider) || {
      status: 'never', analyzedAt: null, messageCount: 0, safeErrorCode: '', userAction: '',
    };
    const operationalStatus = !status.installed
      ? 'cli_missing'
      : !status.authenticated
        ? 'oauth_login_required'
        : lastSyntheticTest.status === 'passed'
          ? 'available'
          : lastSyntheticTest.status === 'failed'
            ? 'unavailable'
            : 'untested';
    return {
      ...status,
      cliInstalled: Boolean(status.installed),
      oauthAuthenticated: Boolean(status.authenticated),
      operationalStatus,
      lastSyntheticTest,
      lastRealMailAnalysis,
    };
  });
}

function validatedPublicConfig(input, base = runtimeConfig, { recordAiOptIn = false } = {}) {
  const next = { ...base };
  for (const key of LEGACY_AI_CONFIG_KEYS) {
    if (Object.hasOwn(input, key)) {
      throw new HttpError(
        400,
        'LEGACY_AI_PROVIDER_UNSUPPORTED',
        `${key} is no longer supported; use an official OAuth CLI provider.`,
      );
    }
  }
  if (typeof input.tenantId === 'string') next.tenantId = validateTenantIdentifier(input.tenantId);
  if (typeof input.clientId === 'string') next.clientId = validateClientIdentifier(input.clientId);
  if (typeof input.mailboxUser === 'string') next.mailboxUser = validateMailboxUser(input.mailboxUser);
  if (typeof input.loginTenant === 'string') {
    const loginTenant = validatedText(input.loginTenant, 'loginTenant', 32);
    if (!['common', 'organizations', 'consumers'].includes(loginTenant)) {
      throw new HttpError(400, 'LOGIN_TENANT_INVALID', 'Login tenant must be common, organizations, or consumers.');
    }
    next.loginTenant = loginTenant;
  }
  if (typeof input.aiProvider === 'string') {
    const aiProvider = validatedText(input.aiProvider, 'aiProvider', 32);
    if (!['rules', 'openai-codex-oauth', 'xai-grok-oauth'].includes(aiProvider)) {
      throw new HttpError(400, 'AI_PROVIDER_INVALID', 'AI provider must be rules, openai-codex-oauth, or xai-grok-oauth.');
    }
    next.aiProvider = aiProvider;
    if (recordAiOptIn) {
      if (aiProvider !== 'rules'
        && input.aiDataPolicyAccepted !== true
        && input.aiOptInVersion !== AI_OPT_IN_VERSION) {
        throw new HttpError(
          400,
          'EXTERNAL_AI_OPT_IN_REQUIRED',
          'OAuth LLM use is disabled until the mail data policy is explicitly accepted.'
        );
      }
      next.aiOptInVersion = aiProvider === 'rules' ? '' : AI_OPT_IN_VERSION;
    }
  }
  if (typeof input.openaiCodexModel === 'string') {
    next.openaiCodexModel = validatedModelIdentifier(input.openaiCodexModel, 'openaiCodexModel', 'luna');
  }
  if (typeof input.xaiGrokModel === 'string') {
    next.xaiGrokModel = validatedModelIdentifier(input.xaiGrokModel, 'xaiGrokModel', 'grok-4.6');
  }
  if (typeof input.domainProfile === 'string') {
    const profile = validatedText(input.domainProfile, 'domainProfile', 50).toLowerCase();
    if (profile && !/^[a-z0-9._-]+$/.test(profile)) {
      throw new HttpError(400, 'DOMAIN_PROFILE_INVALID', 'Domain profile contains unsupported characters.');
    }
    next.domainProfile = profile || 'generic';
  }
  if (typeof input.domainProfiles === 'string') next.domainProfiles = validateDomainProfiles(input.domainProfiles);
  if (!recordAiOptIn && typeof input.aiOptInVersion === 'string') {
    next.aiOptInVersion = input.aiOptInVersion === AI_OPT_IN_VERSION ? AI_OPT_IN_VERSION : '';
  }
  return next;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Request timed out after ${timeoutMs}ms.`);
      timeoutError.code = 'UPSTREAM_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function throwUpstreamHttpError(response, code, label) {
  try {
    await response.body?.cancel();
  } catch {
    // The upstream body may already be closed; never surface it to the client.
  }
  const error = new Error(`${label} failed with HTTP ${response.status}.`);
  error.code = code;
  error.upstreamStatus = response.status;
  throw error;
}

async function readUpstreamJson(response, code, label) {
  try {
    return await response.json();
  } catch (cause) {
    const error = new Error(`${label} returned invalid JSON.`);
    error.code = code;
    error.cause = cause;
    throw error;
  }
}

function getConfigValue(key, envKey) {
  return runtimeConfig[key]?.trim() || process.env[envKey]?.trim() || '';
}

function base64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function redirectUri(req) {
  const requestHost = req.headers.host || `127.0.0.1:${port}`;
  return `http://${requestHost}/auth/callback`;
}

function configStatus() {
  const hasToken = Boolean(getConfigValue('accessToken', 'OUTLOOK_GRAPH_ACCESS_TOKEN'));
  const hasAppCredentials = Boolean(
    getConfigValue('tenantId', 'MICROSOFT_TENANT_ID') &&
    getConfigValue('clientId', 'MICROSOFT_CLIENT_ID') &&
    getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET')
  );
  const capabilities = publicCapabilities();
  const externalActionsAllowed = capabilities.send || capabilities.markRead || capabilities.dataPlane;
  return {
    connected: hasToken || hasAppCredentials,
    authMode: hasToken ? 'access-token' : hasAppCredentials ? 'client-credentials' : 'not-configured',
    mailboxUser: getConfigValue('mailboxUser', 'OUTLOOK_MAILBOX_USER') || null,
    loginTenant: runtimeConfig.loginTenant || 'common',
    tenantId: getConfigValue('tenantId', 'MICROSOFT_TENANT_ID') || '',
    clientId: getConfigValue('clientId', 'MICROSOFT_CLIENT_ID') || '',
    aiProvider: runtimeConfig.aiProvider || 'rules',
    openaiCodexModel: runtimeConfig.openaiCodexModel || DEFAULT_RUNTIME_CONFIG.openaiCodexModel,
    xaiGrokModel: runtimeConfig.xaiGrokModel || DEFAULT_RUNTIME_CONFIG.xaiGrokModel,
    oauthCliProviderVersion: OAUTH_CLI_PROVIDER_VERSION,
    domainProfile: runtimeConfig.domainProfile || 'generic',
    domainProfiles: runtimeConfig.domainProfiles || '',
    aiOptedIn: runtimeConfig.aiProvider !== 'rules' && runtimeConfig.aiOptInVersion === AI_OPT_IN_VERSION,
    aiPipelineVersion: AI_PIPELINE_VERSION,
    aiPolicyVersion: AI_PROMPT_VERSION,
    precisionClassificationVersion: PRECISION_CLASSIFICATION_VERSION,
    intelligentSearchVersion: INTELLIGENT_SEARCH_VERSION,
    operationalClassificationVersion: OPERATIONAL_CLASSIFICATION_VERSION,
    mailAssistantToolsVersion: MAIL_ASSISTANT_TOOLS_VERSION,
    listenHost: host,
    graphConsent: delegatedScopes.split(/\s+/),
    safety: publicSafetyStatus(safetyPolicy),
    capabilities,
    accessKeyRequired,
    secretStorage: shouldPersistSecrets() ? 'encrypted-file' : 'memory-or-environment-only',
    secretsEncryptedAtRest: shouldPersistSecrets(),
    externalActionsAllowed,
    secretsPersisted: shouldPersistSecrets(),
    hasAccessToken: hasToken,
    hasTenantId: Boolean(getConfigValue('tenantId', 'MICROSOFT_TENANT_ID')),
    hasClientId: Boolean(getConfigValue('clientId', 'MICROSOFT_CLIENT_ID')),
    hasClientSecret: Boolean(getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET'))
  };
}

function publicHealthStatus() {
  const status = configStatus();
  const storage = mailMemoryHealth;
  return {
    ok: storage.ready,
    service: 'mail-intelligence',
    version: APP_VERSION,
    ready: storage.ready,
    connected: status.connected,
    authMode: status.authMode,
    aiProvider: status.aiProvider,
    aiPipelineVersion: status.aiPipelineVersion,
    precisionClassificationVersion: status.precisionClassificationVersion,
    intelligentSearchVersion: status.intelligentSearchVersion,
    operationalClassificationVersion: status.operationalClassificationVersion,
    mailAssistantToolsVersion: status.mailAssistantToolsVersion,
    listenHost: status.listenHost,
    graphConsent: status.graphConsent,
    safety: status.safety,
    capabilities: status.capabilities,
    accessKeyRequired: status.accessKeyRequired,
    secretStorage: status.secretStorage,
    secretsEncryptedAtRest: status.secretsEncryptedAtRest,
    externalActionsAllowed: status.externalActionsAllowed,
    secretsPersisted: status.secretsPersisted,
    storage: {
      authoritativeStore: 'sqlite',
      ready: storage.ready,
      schemaVersion: storage.schemaVersion,
      sizeBytes: storage.sizeBytes,
    }
  };
}

function protectedStorageStatus() {
  return requireMailMemory().storageStatus(currentMailboxUser());
}

function attachPrecisionIntelligence(data) {
  const memory = requireMailMemory();
  const mailboxUser = currentMailboxUser();
  const run = memory.classifyStoredPrecision(mailboxUser);
  const mailbox = memory.ensureMailbox(mailboxUser);
  const classificationByMessage = memory.store.getPrecisionClassificationMap(mailbox.id);
  return {
    ...data,
    messages: (data.messages || []).map((message) => ({
      ...message,
      precision: classificationByMessage[message.id] || null,
    })),
    precision: {
      version: PRECISION_CLASSIFICATION_VERSION,
      searchVersion: INTELLIGENT_SEARCH_VERSION,
      operationalVersion: OPERATIONAL_CLASSIFICATION_VERSION,
      assistantToolsVersion: MAIL_ASSISTANT_TOOLS_VERSION,
      run,
      summary: memory.precisionSummary(mailboxUser, { classifyPending: false }),
    },
  };
}

async function readFeedbackContext() {
  const cacheKey = currentMailboxKey();
  const feedback = requireMailMemory().getFeedbackMap(currentMailboxUser());
  return { cacheKey, feedback };
}

async function saveClassificationFeedback(input) {
  const messageId = String(input.messageId || '').trim();
  const rawStatus = String(input.userStatus || '').trim().toLowerCase();
  const userStatus = FEEDBACK_STATUSES.has(rawStatus) ? rawStatus : '';
  const reasonCode = String(input.reasonCode || userStatus).trim();
  const note = compactText(input.note || '', 500);
  if (!messageId) {
    const error = new Error('messageId is required.');
    error.statusCode = 400;
    throw error;
  }
  if (!FEEDBACK_STATUSES.has(userStatus)) {
    const error = new Error('userStatus must be one of urgent, active, waiting, done, reference.');
    error.statusCode = 400;
    throw error;
  }

  const memory = requireMailMemory();
  const mailbox = memory.ensureMailbox(currentMailboxUser());
  const message = memory.store.getMessageRecord(mailbox.id, messageId) || {};
  return memory.saveFeedback(currentMailboxUser(), messageId, {
    userStatus,
    reasonCode: FEEDBACK_REASON_CODES.has(reasonCode) ? reasonCode : userStatus,
    reasonLabel: FEEDBACK_REASONS[reasonCode] || FEEDBACK_REASONS[userStatus],
    note,
    sender: emailAddress(message.sender_email || input.sender || ''),
    subject: compactText(message.subject || input.subject || '', 180),
    subjectTokens: subjectTokens(message.subject || input.subject || ''),
    savedAt: new Date().toISOString()
  });
}

function applyFeedbackToResult(result, messages, feedback = {}, options = {}) {
  const allowLearnedOverride = options.allowLearnedOverride !== false;
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const messageInsights = (result.messageInsights || []).map((insight) => {
    const message = messageById.get(insight.id) || insight;
    const exact = feedback[insight.id];
    if (exact && FEEDBACK_STATUSES.has(exact.userStatus)) {
      const isNonActionable = exact.userStatus === 'done' || exact.userStatus === 'reference';
      return {
        ...insight,
        userFeedback: exact,
        isOnHold: exact.reasonCode === 'hold',
        isSpamCandidate: Boolean(message.isPromotional),
        spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
        effectiveStatus: exact.userStatus,
        nextActions: isNonActionable ? [] : insight.nextActions,
        feedbackApplied: true
      };
    }
    const learned = allowLearnedOverride ? inferredFeedbackStatus(message, feedback) : null;
    if (learned) {
      const isNonActionable = learned.item.userStatus === 'done' || learned.item.userStatus === 'reference';
      return {
        ...insight,
        feedbackHint: {
          userStatus: learned.item.userStatus,
          reasonCode: learned.item.reasonCode,
          reasonLabel: learned.item.reasonLabel,
          score: learned.score
        },
        isSpamCandidate: Boolean(message.isPromotional),
        spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
        effectiveStatus: learned.item.userStatus,
        nextActions: isNonActionable ? [] : insight.nextActions
      };
    }
    return {
      ...insight,
      isSpamCandidate: Boolean(message.isPromotional),
      spamReason: message.isPromotional ? '광고성/뉴스레터 패턴 감지' : '',
      effectiveStatus: insight.effectiveStatus || insight.status || 'reference'
    };
  });

  const actionableMessageIds = new Set(
    messageInsights
      .filter((insight) => !['done', 'reference'].includes(insight.effectiveStatus || insight.status))
      .map((insight) => insight.id)
  );
  const nextActions = (result.nextActions || [])
    .filter((action) => !action.messageId || actionableMessageIds.has(action.messageId))
    .map((action) => {
      const insight = messageInsights.find((item) => item.id === action.messageId);
      return insight ? { ...action, lane: insight.effectiveStatus || action.lane } : action;
    });
  const counts = Object.fromEntries(
    ['urgent', 'active', 'waiting', 'done', 'reference'].map((status) => [
      status,
      messageInsights.filter((insight) => (insight.effectiveStatus || insight.status) === status).length
    ])
  );

  return {
    ...result,
    messageInsights,
    tasks: (result.tasks || []).filter((item) => !item.messageId || actionableMessageIds.has(item.messageId)),
    nextActions,
    calendar: (result.calendar || []).filter((item) => !item.messageId || actionableMessageIds.has(item.messageId)),
    reminders: (result.reminders || []).filter((item) => !item.messageId || actionableMessageIds.has(item.messageId)),
    counts
  };
}

async function getGraphAccessToken() {
  const directToken = getConfigValue('accessToken', 'OUTLOOK_GRAPH_ACCESS_TOKEN');
  if (directToken && (!runtimeConfig.expiresAt || Date.now() < runtimeConfig.expiresAt - 60_000)) return directToken;

  if (runtimeConfig.refreshToken && runtimeConfig.clientId && runtimeConfig.tenantId) {
    const refreshParams = {
      client_id: runtimeConfig.clientId,
      grant_type: 'refresh_token',
      refresh_token: runtimeConfig.refreshToken,
      scope: delegatedScopes
    };
    if (runtimeConfig.clientSecret) {
      refreshParams.client_secret = runtimeConfig.clientSecret;
    }
    const body = new URLSearchParams(refreshParams);
    const response = await fetchWithTimeout(`https://login.microsoftonline.com/${runtimeConfig.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }, 20_000);
    if (!response.ok) {
      await throwUpstreamHttpError(response, 'MICROSOFT_REFRESH_FAILED', 'Microsoft refresh token request');
    }
    const payload = await readUpstreamJson(response, 'MICROSOFT_REFRESH_JSON_INVALID', 'Microsoft refresh token request');
    runtimeConfig.accessToken = payload.access_token || '';
    runtimeConfig.refreshToken = payload.refresh_token || runtimeConfig.refreshToken;
    runtimeConfig.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
    await savePersistedConfig();
    return runtimeConfig.accessToken;
  }

  const tenantId = getConfigValue('tenantId', 'MICROSOFT_TENANT_ID');
  const clientId = getConfigValue('clientId', 'MICROSOFT_CLIENT_ID');
  const clientSecret = getConfigValue('clientSecret', 'MICROSOFT_CLIENT_SECRET');
  if (!tenantId || !clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await fetchWithTimeout(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, 20_000);

  if (!response.ok) {
    await throwUpstreamHttpError(response, 'MICROSOFT_TOKEN_FAILED', 'Microsoft token request');
  }

  const payload = await readUpstreamJson(response, 'MICROSOFT_TOKEN_JSON_INVALID', 'Microsoft token request');
  return payload.access_token;
}

async function fetchOutlookMessages(top = 25, { forceInitial = false } = {}) {
  const memory = requireMailMemory();
  const mailboxUser = currentMailboxUser();
  const cacheKey = mailboxCacheKey(mailboxUser);
  const requestedTop = Math.min(Math.max(top, 1), 50);
  const mailbox = memory.ensureMailbox(mailboxUser);
  const cachedMessages = memory.getMessages(mailboxUser, { limit: requestedTop });
  const cachedBefore = memory.store.countMessages(mailbox.id);
  const accessToken = await getGraphAccessToken();
  if (!accessToken) {
    return attachPrecisionIntelligence({
      connected: false,
      mode: 'offline-cache',
      message: cachedMessages.length
        ? 'Microsoft Graph credentials are not configured. Showing SQLite persistent mail memory.'
        : 'Microsoft Graph credentials are not configured. Configure Outlook integration to collect mail.',
      messages: cachedMessages,
      sync: {
        mailbox: cacheKey,
        mode: 'offline-cache',
        authoritativeStore: 'sqlite',
        fetchedFromGraph: 0,
        cachedBefore,
        totalCached: cachedBefore,
        status: memory.syncStatus(mailboxUser)
      }
    });
  }

  try {
    const synchronized = await memory.syncMailbox({
      accessToken,
      mailboxUser,
      recentLimit: requestedTop,
      forceInitial
    });
    return attachPrecisionIntelligence({
      connected: true,
      mode: mailboxUser ? 'application-mailbox' : 'delegated-me',
      message: synchronized.failedFolders
        ? `Outlook synchronized with ${synchronized.failedFolders} folder warning(s).`
        : 'Outlook folders synchronized into SQLite persistent mail memory.',
      messages: synchronized.messages,
      sync: {
        mailbox: cacheKey,
        mode: forceInitial ? 'full-reset' : 'delta',
        authoritativeStore: 'sqlite',
        discoveredFolders: synchronized.discoveredFolders,
        completedFolders: synchronized.completedFolders,
        failedFolders: synchronized.failedFolders,
        pagesProcessed: synchronized.pages,
        fetchedFromGraph: synchronized.received,
        upserted: synchronized.upserts,
        deleted: synchronized.deletions,
        attachmentErrors: synchronized.attachmentErrors,
        cachedBefore,
        totalCached: memory.store.countMessages(synchronized.mailbox.id),
        folderResults: synchronized.folderResults,
        errors: synchronized.errors,
        status: memory.syncStatus(mailboxUser)
      }
    });
  } catch (error) {
    if (!cachedMessages.length) throw error;
    return attachPrecisionIntelligence({
      connected: false,
      mode: 'offline-cache',
      message: `Microsoft Graph sync failed. Showing SQLite persistent mail memory: ${error instanceof Error ? error.message : 'unknown error'}`,
      messages: cachedMessages,
      sync: {
        mailbox: cacheKey,
        mode: 'offline-cache',
        authoritativeStore: 'sqlite',
        status: 'degraded',
        errorCode: error?.code || 'MICROSOFT_GRAPH_SYNC_FAILED',
        fetchedFromGraph: 0,
        cachedBefore,
        totalCached: cachedBefore,
        syncStatus: memory.syncStatus(mailboxUser)
      }
    });
  }
}

function clip(value = '', max = 5000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function replySubject(subject = '') {
  return /^re:/i.test(subject) ? subject : `RE: ${subject || '(제목 없음)'}`;
}

function normalizePrimaryAction(message, action, summaries = [], status = 'active') {
  if (!action || status === 'reference' || status === 'done') return [];
  const recipient = emailAddress(message.from || '');
  const summaryLines = (summaries.length ? summaries : [message.bodyPreview || message.subject || '메일 내용을 확인했습니다.'])
    .slice(0, 3)
    .map((item) => `- ${item}`)
    .join('\n');
  return [{
    id: `ai-primary-${message.id}`,
    scenario: 1,
    title: status === 'urgent' ? '긴급 업무 처리' : status === 'waiting' ? '대기 상태 확인' : '다음 업무 진행',
    intent: action.intent || '메일의 가장 중요한 후속 행동 하나를 우선 제안합니다.',
    owner: action.owner || '미지정',
    due: action.due || '',
    recommendedAction: action.recommendedAction,
    lane: action.lane,
    priority: Number(action.priority || (status === 'urgent' ? 1 : 4)),
    evidence: action.evidence,
    subject: message.subject,
    messageId: message.id,
    receivedAt: message.receivedAt,
    webLink: message.webLink,
    to: action.to || recipient,
    mailSubject: action.mailSubject || action.subject || replySubject(message.subject),
    body: action.body || `안녕하세요.\n\n메일 내용 확인했습니다.\n\n핵심 내용은 아래와 같습니다.\n${summaryLines}\n\n내부 확인 후 진행 상황을 안내드리겠습니다.\n\n감사합니다.`,
    profile: 'generic'
  }];
}

function inferLegacyActionType(action = {}) {
  if (action.actionType) return action.actionType;
  if (action.to || action.subject || action.body || action.mailSubject) return 'draft_reply';
  return 'review';
}

function normalizeLegacyProviderResponse(raw) {
  const payload = extractJsonObject(raw);
  if (!payload || !Array.isArray(payload.messages)) return raw;
  return JSON.stringify({
    ...payload,
    messages: payload.messages.map((message) => ({
      ...message,
      confidence: typeof message?.confidence === 'number' ? message.confidence : 0.65,
      nextActions: Array.isArray(message?.nextActions)
        ? message.nextActions.map((action) => ({
          ...action,
          actionType: inferLegacyActionType(action)
        }))
        : message?.nextActions
    }))
  });
}

async function executeAiRoute(selectedProvider, prompt) {
  assertCapability(safetyPolicy, 'externalAi');
  if (runtimeConfig.aiOptInVersion !== AI_OPT_IN_VERSION) {
    throw new HttpError(403, 'EXTERNAL_AI_OPT_IN_REQUIRED', 'OAuth LLM data-policy acceptance is required.');
  }
  const attempts = [];
  const model = providerModel(selectedProvider, runtimeConfig);
  try {
    const status = await oauthProviderStatus(selectedProvider);
    if (!status.installed) {
      const error = new Error(status.error || 'OAuth provider CLI is not installed.');
      error.code = 'OAUTH_PROVIDER_NOT_INSTALLED';
      throw error;
    }
    if (!status.authenticated) {
      const error = new Error(status.error || 'OAuth provider login is required.');
      error.code = 'OAUTH_PROVIDER_NOT_AUTHENTICATED';
      throw error;
    }
    const execution = await withAiResilience(selectedProvider, async ({ attempt }) => {
      try {
        const result = await runOAuthCliProvider(selectedProvider, prompt, {
          model,
          configuredPath: oauthCliConfiguredPath(selectedProvider),
          schemaPath: join(appRoot, 'schemas', 'mail-analysis.schema.json'),
        });
        attempts.push({ provider: selectedProvider, model, attempt, status: 'succeeded', authMode: status.authMode });
        return result;
      } catch (error) {
        const safe = safeProviderFailure(error);
        attempts.push({
          provider: selectedProvider,
          model,
          attempt,
          status: 'failed',
          code: safe.safeErrorCode,
          error: safe.message,
          userAction: safe.userAction,
        });
        error.safeProviderFailure = safe;
        throw error;
      }
    }, {
      retries: 0,
      retryDelayMs: 0,
      failureThreshold: 3,
      cooldownMs: 60_000,
    });
    return {
      text: execution.text,
      provider: selectedProvider,
      model: execution.model || model,
      attempts,
      requestedProvider: selectedProvider,
      fallbackFrom: null,
      fallback: null,
    };
  } catch (error) {
    const safe = error?.safeProviderFailure || safeProviderFailure(error);
    error.attempts = attempts;
    error.aiRun = failedAiRun(new Error(safe.message), {
      provider: selectedProvider,
      model,
      attempts,
    });
    error.safeProviderFailure = safe;
    throw error;
  }
}

async function enrichWithAI(messages, result) {
  const selectedProvider = runtimeConfig.aiProvider || 'rules';
  const selectedModel = providerModel(selectedProvider, runtimeConfig);
  if (selectedProvider === 'rules') {
    return {
      ...result,
      ai: {
        enabled: false,
        status: 'not-run',
        provider: 'rules',
        model: 'rules',
        pipelineVersion: AI_PIPELINE_VERSION,
        reason: 'AI provider is disabled by default. Rules-only analysis is active.'
      }
    };
  }
  if (messages.length === 0) {
    return {
      ...result,
      ai: {
        enabled: false,
        status: 'not-run',
        provider: 'rules',
        model: 'rules',
        pipelineVersion: AI_PIPELINE_VERSION,
        reason: 'No messages to analyze.'
      }
    };
  }

  const memory = requireMailMemory();
  const mailboxUser = currentMailboxUser();
  const feedback = memory.getFeedbackMap(mailboxUser);
  const feedbackExamples = feedbackForPrompt(feedback);
  const cachedById = new Map();
  const messagesForAi = [];
  for (const message of messages) {
    const key = buildAnalysisCacheKey({
      message,
      provider: selectedProvider,
      model: selectedModel,
      pipelineVersion: AI_PIPELINE_VERSION
    });
    const cached = memory.getAnalysis(mailboxUser, message.id, key);
    if (cached) {
      cachedById.set(message.id, cached);
    } else {
      messagesForAi.push(message);
    }
  }
  if (messagesForAi.length === 0) {
    const cachedInsights = result.messageInsights.map((insight) => {
      const cached = cachedById.get(insight.id);
      const message = messages.find((item) => item.id === insight.id) || insight;
      return cached
        ? {
          ...insight,
          ...cached,
          nextActions: normalizePrimaryAction(
            message,
            cached.nextActions?.[0],
            cached.summary || insight.summary,
            cached.status
          ),
          analysisMode: 'ai',
          analysisState: 'succeeded',
          aiEnhanced: true,
          aiCached: true
        }
        : insight;
    });
    return {
      ...result,
      messageInsights: cachedInsights,
      nextActions: cachedInsights.flatMap((insight) => insight.nextActions || []).sort((a, b) => a.priority - b.priority),
      reminders: cachedInsights
        .flatMap((insight) => insight.nextActions || [])
        .filter((action) => action.lane === 'urgent' || action.due)
        .map((action) => ({
          title: action.recommendedAction,
          reason: action.evidence,
          owner: action.owner,
          subject: action.subject,
          messageId: action.messageId,
          receivedAt: action.receivedAt,
          webLink: action.webLink
        })),
      ai: {
        enabled: true,
        status: 'succeeded',
        provider: selectedProvider,
        requestedProvider: selectedProvider,
        model: selectedModel,
        pipelineVersion: AI_PIPELINE_VERSION,
        policyVersion: AI_PROMPT_VERSION,
        analyzed: 0,
        cached: messages.length,
        cachedOnly: true,
        fallbackFrom: null,
        fallback: null,
        attempts: []
      }
    };
  }

  const prompt = buildAnalysisPrompt(feedbackExamples, messagesForAi);
  const analysisStartedAt = Date.now();
  let execution;
  try {
    execution = await executeAiRoute(selectedProvider, prompt);
  } catch (error) {
    const safe = error?.safeProviderFailure || safeProviderFailure(error);
    if (shouldRecordOAuthProviderFailure(error)) {
      recordProviderRuntimeEvent('oauth.provider.real_mail_analysis', selectedProvider, {
        status: 'failed',
        analyzedAt: new Date().toISOString(),
        latencyMs: Date.now() - analysisStartedAt,
        messageCount: messagesForAi.length,
        model: selectedModel,
        ...safe,
      });
    }
    throw error;
  }
  let ai;
  try {
    ai = parseAiAnalysis(normalizeLegacyProviderResponse(execution.text), {
      expectedMessageIds: messagesForAi.map((message) => message.id),
      sourceTextById: Object.fromEntries(messagesForAi.map((message) => [
        message.id,
        `${message.subject || ''}\n${message.body || message.bodyPreview || ''}`
      ]))
    });
  } catch (error) {
    const safe = safeProviderFailure(error);
    recordProviderRuntimeEvent('oauth.provider.real_mail_analysis', selectedProvider, {
      status: 'failed',
      analyzedAt: new Date().toISOString(),
      latencyMs: Date.now() - analysisStartedAt,
      messageCount: messagesForAi.length,
      model: execution.model || selectedModel,
      ...safe,
    });
    error.attempts = execution.attempts;
    error.aiRun = failedAiRun(new Error(safe.message), {
      provider: execution.provider,
      model: execution.model,
      attempts: execution.attempts
    });
    throw error;
  }
  recordProviderRuntimeEvent('oauth.provider.real_mail_analysis', selectedProvider, {
    status: 'passed',
    analyzedAt: new Date().toISOString(),
    latencyMs: Date.now() - analysisStartedAt,
    messageCount: messagesForAi.length,
    model: execution.model || selectedModel,
    safeErrorCode: '',
    userAction: '',
  });
  const byId = new Map((ai.messages || []).map((item) => [item.id, item]));
  const aiMessageIds = new Set(messagesForAi.map((message) => message.id));
  const enhancedInsights = result.messageInsights.map((insight) => {
    const message = messages.find((item) => item.id === insight.id) || insight;
    const cachedInsight = cachedById.get(insight.id);
    if (cachedInsight) {
      return {
        ...insight,
        ...cachedInsight,
        nextActions: normalizePrimaryAction(
          message,
          cachedInsight.nextActions?.[0],
          cachedInsight.summary || insight.summary,
          cachedInsight.status
        ),
        analysisMode: 'ai',
        analysisState: 'succeeded',
        aiEnhanced: true,
        aiCached: true
      };
    }

    const aiInsight = byId.get(insight.id);
    if (!aiInsight) return insight;
    const status = aiInsight.status;
    const nextActions = normalizePrimaryAction(
      message,
      aiInsight.nextActions?.[0],
      aiInsight.summary || insight.summary,
      status
    );
    return {
      ...insight,
      status,
      confidence: aiInsight.confidence,
      summary: aiInsight.summary,
      nextActions,
      evidenceItems: aiInsight.evidenceItems.length ? aiInsight.evidenceItems : insight.evidenceItems,
      aiRationale: aiInsight.aiRationale || '',
      analysisMode: 'ai',
      analysisState: 'succeeded',
      aiEnhanced: true
    };
  });

  for (const insight of enhancedInsights) {
    if (!aiMessageIds.has(insight.id) || !insight.aiEnhanced) continue;
    const message = messages.find((item) => item.id === insight.id);
    if (!message) continue;
    const analysisKey = buildAnalysisCacheKey({
      message,
      provider: execution.provider,
      model: execution.model,
      pipelineVersion: AI_PIPELINE_VERSION
    });
    memory.saveAnalysis(mailboxUser, insight.id, analysisKey, {
      source: 'ai',
      status: insight.status,
      confidence: insight.confidence,
      summary: insight.summary,
      nextActions: insight.nextActions,
      evidenceItems: insight.evidenceItems,
      aiRationale: insight.aiRationale,
      provider: execution.provider,
      model: execution.model,
      promptVersion: AI_PROMPT_VERSION
    });
  }

  const nextActions = enhancedInsights.flatMap((insight) => insight.nextActions || []).sort((a, b) => a.priority - b.priority);
  const reminders = nextActions
    .filter((action) => action.lane === 'urgent' || action.due)
    .map((action) => ({
      title: action.recommendedAction,
      reason: action.evidence,
      owner: action.owner,
      subject: action.subject,
      messageId: action.messageId,
      receivedAt: action.receivedAt,
      webLink: action.webLink
    }));

  return {
    ...result,
    messageInsights: enhancedInsights,
    nextActions,
    reminders,
    ai: {
      enabled: true,
      status: 'succeeded',
      provider: execution.provider,
      requestedProvider: execution.requestedProvider,
      model: execution.model,
      pipelineVersion: AI_PIPELINE_VERSION,
      policyVersion: AI_PROMPT_VERSION,
      analyzed: messagesForAi.length,
      cached: cachedById.size,
      cachedOnly: false,
      fallbackFrom: execution.fallbackFrom,
      fallback: execution.fallback,
      attempts: execution.attempts
    }
  };
}

function precisionCandidateFromAiInsight(insight = {}) {
  const status = String(insight.status || '').trim().toLowerCase();
  const workState = {
    urgent: 'action_required',
    active: 'action_required',
    waiting: 'waiting',
    done: 'completed',
    reference: 'reference',
    hold: 'review_required',
  }[status] || 'review_required';
  const nextActor = workState === 'action_required'
    ? 'me'
    : workState === 'waiting'
      ? 'external_party'
      : ['completed', 'reference'].includes(workState)
        ? 'none'
        : 'unknown';
  const priority = status === 'urgent'
    ? 'high'
    : workState === 'reference'
      ? 'low'
      : 'normal';
  return {
    workState,
    nextActor,
    priority,
    confidence: Number.isFinite(Number(insight.confidence))
      ? Math.max(0, Math.min(1, Number(insight.confidence)))
      : 0,
    summary: String(insight.summary || '').slice(0, 600),
    evidenceItems: Array.isArray(insight.evidenceItems)
      ? insight.evidenceItems.slice(0, 8)
      : [],
    aiRationale: String(insight.aiRationale || '').slice(0, 1000),
  };
}

async function selectivelyAdjudicateMessage(messageId) {
  const memory = requireMailMemory();
  const mailboxUser = currentMailboxUser();
  const candidate = memory.adjudicationCandidate(mailboxUser, messageId);
  if (!candidate.eligible) {
    return {
      status: 'not_required',
      rulesUsed: true,
      persisted: false,
      requiresHumanApproval: false,
      rules: candidate.rules,
      safety: candidate.safety,
    };
  }

  if (String(process.env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI || '') !== '1') {
    return {
      status: 'policy_blocked',
      code: 'EXTERNAL_AI_DISABLED',
      fallback: 'rules_review',
      rulesUsed: true,
      persisted: false,
      requiresHumanApproval: true,
      rules: candidate.rules,
      safety: candidate.safety,
    };
  }

  if (runtimeConfig.aiProvider !== 'openai-codex-oauth') {
    return {
      status: 'provider_not_selected',
      code: 'LUNA_NOT_SELECTED',
      fallback: 'rules_review',
      rulesUsed: true,
      persisted: false,
      requiresHumanApproval: true,
      rules: candidate.rules,
      safety: candidate.safety,
    };
  }

  const sanitized = {
    id: candidate.message.id,
    subject: candidate.message.subject,
    body: candidate.message.currentContent,
    bodyPreview: candidate.message.currentContent,
    receivedAt: candidate.message.receivedAt,
    folderName: candidate.message.folder,
    attachments: candidate.message.attachments,
  };
  try {
    const prompt = buildAnalysisPrompt([], [sanitized]);
    const execution = await executeAiRoute('openai-codex-oauth', prompt);
    const parsed = parseAiAnalysis(normalizeLegacyProviderResponse(execution.text), {
      expectedMessageIds: [sanitized.id],
      sourceTextById: {
        [sanitized.id]: `${sanitized.subject || ''}\n${sanitized.body || ''}`,
      },
    });
    const insight = parsed.messages?.find((item) => item.id === sanitized.id)
      || parsed.messages?.[0]
      || null;
    if (!insight) throw new Error('Selective Luna adjudication returned no candidate.');
    const luna = precisionCandidateFromAiInsight(insight);
    const agrees = luna.workState === candidate.rules.workState
      && luna.nextActor === candidate.rules.nextActor;
    return {
      status: agrees ? 'agreed' : 'disagreed',
      provider: 'openai-codex-oauth',
      model: execution.model || 'luna',
      fallback: agrees ? null : 'rules_review',
      rulesUsed: true,
      persisted: false,
      requiresHumanApproval: true,
      rules: candidate.rules,
      luna,
      safety: candidate.safety,
    };
  } catch (error) {
    const safe = error?.safeProviderFailure || safeProviderFailure(error);
    return {
      status: 'failed',
      code: safe.safeErrorCode,
      message: safe.message,
      userAction: safe.userAction,
      fallback: 'rules_review',
      rulesUsed: true,
      persisted: false,
      requiresHumanApproval: true,
      rules: candidate.rules,
      safety: candidate.safety,
    };
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
  try {
    assertAllowedHost(req);

    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return json(res, 200, publicHealthStatus());
    }

    if (url.pathname === '/api/session') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      issueLocalSession(req, res);
      return;
    }

    if (url.pathname === '/api/ai/oauth/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const providers = await oauthProviderStatuses();
      return json(res, 200, {
        providerVersion: OAUTH_CLI_PROVIDER_VERSION,
        externalAiEnabled: String(process.env.MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI || '') === '1',
        selectedProvider: runtimeConfig.aiProvider,
        dataPolicyAccepted: runtimeConfig.aiOptInVersion === AI_OPT_IN_VERSION,
        providers,
      });
    }

    if (url.pathname === '/api/ai/oauth/instructions') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const provider = validatedText(url.searchParams.get('provider') || '', 'provider', 32);
      try {
        return json(res, 200, oauthProviderLoginInstructions(provider));
      } catch (error) {
        throw new HttpError(400, 'AI_PROVIDER_INVALID', error instanceof Error ? error.message : 'OAuth provider is invalid.');
      }
    }

    if (url.pathname === '/api/ai/oauth/test') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const provider = validatedText(body.provider || runtimeConfig.aiProvider, 'provider', 32);
      if (!['openai-codex-oauth', 'xai-grok-oauth'].includes(provider)) {
        throw new HttpError(400, 'AI_PROVIDER_INVALID', 'OAuth provider must be openai-codex-oauth or xai-grok-oauth.');
      }
      const model = provider === 'openai-codex-oauth'
        ? validatedModelIdentifier(body.model || runtimeConfig.openaiCodexModel, 'openaiCodexModel', 'luna')
        : validatedModelIdentifier(body.model || runtimeConfig.xaiGrokModel, 'xaiGrokModel', 'grok-4.6');
      const startedAt = Date.now();
      try {
        const result = await testOAuthProvider(provider, model);
        const state = {
          status: 'passed',
          testedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          model: result.model || model,
          safeErrorCode: '',
          userAction: '',
        };
        recordProviderRuntimeEvent('oauth.provider.synthetic_test', provider, state);
        return json(res, 200, { ...result, ...state });
      } catch (error) {
        const safe = safeProviderFailure(error);
        const state = {
          status: 'failed',
          testedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          model,
          ...safe,
        };
        recordProviderRuntimeEvent('oauth.provider.synthetic_test', provider, state);
        return json(res, 424, { ok: false, provider, ...state });
      }
    }

    if (url.pathname === '/api/outlook/oauth/start') {
      let input;
      const redirectResponse = req.method === 'GET';
      if (redirectResponse) {
        requireSessionCookie(req);
        input = {
          clientId: url.searchParams.get('clientId') || '',
          tenantId: url.searchParams.get('tenantId') || '',
          mailboxUser: url.searchParams.get('mailboxUser') || ''
        };
      } else if (req.method === 'POST') {
        requireStateChange(req);
        input = await readJsonBody(req);
      } else {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      }
      const clientId = validateClientIdentifier(input.clientId || getConfigValue('clientId', 'MICROSOFT_CLIENT_ID'));
      const tenantId = validatedText(input.tenantId || runtimeConfig.loginTenant || 'common', 'loginTenant', 32);
      const mailbox = validateMailboxUser(input.mailboxUser || '');
      if (!clientId) throw new HttpError(400, 'CLIENT_ID_REQUIRED', 'Client ID is required.');
      if (!['common', 'organizations', 'consumers'].includes(tenantId)) {
        throw new HttpError(400, 'LOGIN_TENANT_INVALID', 'Login tenant must be common, organizations, or consumers.');
      }

      const state = base64Url(randomBytes(24));
      const codeVerifier = base64Url(randomBytes(48));
      const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
      prunePendingOAuth();
      trimOldestEntry(pendingOAuth, MAX_PENDING_OAUTH_STATES);
      pendingOAuth.set(state, {
        codeVerifier,
        clientId,
        tenantId,
        mailboxUser: mailbox,
        createdAt: Date.now(),
        redirectUri: redirectUri(req)
      });

      const authorize = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('redirect_uri', redirectUri(req));
      authorize.searchParams.set('response_mode', 'query');
      authorize.searchParams.set('scope', delegatedScopes);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', codeChallenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      if (redirectResponse) {
        res.writeHead(302, { ...securityHeaders(), Location: authorize.toString() });
        res.end();
        return;
      }
      return json(res, 200, { authorizeUrl: authorize.toString() });
    }

    if (url.pathname === '/api/outlook/config') {
      if (req.method === 'GET') {
        requireSessionCookie(req);
        return json(res, 200, configStatus());
      }
      if (req.method === 'POST') {
        requireStateChange(req);
        const body = await readJsonBody(req);
        const nextConfig = validatedPublicConfig(body, runtimeConfig, { recordAiOptIn: true });
        for (const key of ['accessToken', 'clientSecret', 'geminiApiKey']) {
          if (typeof body[key] === 'string' && body[key].trim()) {
            nextConfig[key] = validatedText(body[key], key, MAX_JSON_BODY_BYTES);
          }
        }
        if (body.persist !== false) await savePersistedConfig(nextConfig);
        Object.assign(runtimeConfig, nextConfig);
        return json(res, 200, configStatus());
      }
      if (req.method === 'DELETE') {
        requireStateChange(req);
        await savePersistedConfig(DEFAULT_RUNTIME_CONFIG);
        Object.assign(runtimeConfig, DEFAULT_RUNTIME_CONFIG);
        return json(res, 200, configStatus());
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    }

    if (url.pathname === '/api/outlook/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, {
        ...configStatus(),
        storage: protectedStorageStatus(),
      });
    }

    if (url.pathname === '/api/intelligence/summary') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, {
        version: PRECISION_CLASSIFICATION_VERSION,
        searchVersion: INTELLIGENT_SEARCH_VERSION,
        operationalVersion: OPERATIONAL_CLASSIFICATION_VERSION,
        assistantToolsVersion: MAIL_ASSISTANT_TOOLS_VERSION,
        ...requireMailMemory().precisionSummary(currentMailboxUser()),
      });
    }

    if (url.pathname === '/api/intelligence/operational-summary') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, {
        version: OPERATIONAL_CLASSIFICATION_VERSION,
        ...requireMailMemory().operationalSummary(currentMailboxUser()),
      });
    }

    if (url.pathname === '/api/intelligence/message-summary') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const messageId = validatedText(url.searchParams.get('messageId') || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().messageSummary(currentMailboxUser(), messageId));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/thread-summary') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const messageId = validatedText(url.searchParams.get('messageId') || '', 'messageId', 500);
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new HttpError(400, 'THREAD_LIMIT_INVALID', 'limit must be an integer between 1 and 500.');
      }
      try {
        return json(res, 200, requireMailMemory().threadSummary(currentMailboxUser(), messageId, { limit }));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/meeting-candidate') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const messageId = validatedText(url.searchParams.get('messageId') || '', 'messageId', 500);
      const timeZone = validatedText(url.searchParams.get('timeZone') || 'Asia/Seoul', 'timeZone', 80);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().meetingCandidate(currentMailboxUser(), messageId, { timeZone }));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/attachments') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const messageId = validatedText(url.searchParams.get('messageId') || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().messageAttachments(currentMailboxUser(), messageId));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/personality') {
      if (req.method === 'GET') {
        requireSessionCookie(req);
        return json(res, 200, {
          version: MAIL_ASSISTANT_TOOLS_VERSION,
          personality: requireMailMemory().assistantPersonality(currentMailboxUser()),
        });
      }
      if (req.method === 'POST') {
        requireStateChange(req);
        const body = await readJsonBody(req);
        return json(res, 200, {
          version: MAIL_ASSISTANT_TOOLS_VERSION,
          personality: requireMailMemory().saveAssistantPersonality(currentMailboxUser(), {
            role: validatedText(body.role || '', 'role', 120),
            tone: validatedText(body.tone || '', 'tone', 120),
            opening: validatedText(body.opening || '', 'opening', 120),
          }),
        });
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    }

    if (url.pathname === '/api/intelligence/draft') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      const mode = validatedText(body.mode || 'rapid_reply', 'mode', 40);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      if (!['rapid_reply', 'improve', 'meeting_confirmation'].includes(mode)) {
        throw new HttpError(400, 'DRAFT_MODE_INVALID', 'mode must be rapid_reply, improve, or meeting_confirmation.');
      }
      try {
        return json(res, 200, requireMailMemory().generateAssistantDraft(currentMailboxUser(), messageId, {
          mode,
          draftText: validatedText(body.draftText || '', 'draftText', 12_000),
          timeZone: validatedText(body.timeZone || 'Asia/Seoul', 'timeZone', 80),
        }));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/confirm') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().confirmPrecisionClassification(currentMailboxUser(), messageId, {
          note: validatedText(body.note || '', 'note', 500),
        }));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/attachment-summary') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      const attachmentId = validatedText(body.attachmentId || '', 'attachmentId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      if (!attachmentId) throw new HttpError(400, 'ATTACHMENT_ID_REQUIRED', 'attachmentId is required.');
      try {
        return json(res, 200, requireMailMemory().attachmentSummary(
          currentMailboxUser(),
          messageId,
          attachmentId,
          { extractedText: validatedText(body.extractedText || '', 'extractedText', 200_000) },
        ));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        if (/attachment metadata/i.test(error?.message || '')) {
          throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', 'Stored attachment metadata was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/adjudicate') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, await selectivelyAdjudicateMessage(messageId));
      } catch (error) {
        if (/stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/smart-views') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, {
        version: INTELLIGENT_SEARCH_VERSION,
        views: requireMailMemory().intelligentSmartViews(),
      });
    }

    if (url.pathname === '/api/intelligence/projects') {
      if (req.method === 'GET') {
        requireSessionCookie(req);
        return json(res, 200, {
          projects: requireMailMemory().listProjects(currentMailboxUser()),
        });
      }
      if (req.method === 'POST') {
        requireStateChange(req);
        const body = await readJsonBody(req);
        const name = validatedText(body.name, 'name', 200);
        if (name.length < 2) throw new HttpError(400, 'PROJECT_NAME_INVALID', 'Project name must contain at least two characters.');
        if (body.aliases != null && !Array.isArray(body.aliases)) {
          throw new HttpError(400, 'PROJECT_ALIASES_INVALID', 'aliases must be an array.');
        }
        const aliases = (body.aliases || []).map((alias, index) => validatedText(alias, `aliases[${index}]`, 200));
        if (aliases.length > 30) throw new HttpError(400, 'PROJECT_ALIASES_INVALID', 'At most 30 aliases are allowed.');
        try {
          const result = requireMailMemory().createProject(currentMailboxUser(), {
            name,
            projectKey: validatedText(body.projectKey || '', 'projectKey', 120),
            aliases,
          });
          return json(res, 201, result);
        } catch (error) {
          if (error?.code === 'PROJECT_ALIAS_CONFLICT') {
            throw new HttpError(409, error.code, error.message);
          }
          throw error;
        }
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    }

    if (url.pathname === '/api/intelligence/classification') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const messageId = validatedText(url.searchParams.get('messageId') || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().getPrecisionClassification(currentMailboxUser(), messageId));
      } catch (error) {
        if (/stored message|unknown message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/classify') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      if (messageId) {
        try {
          return json(res, 200, requireMailMemory().classifyPrecision(currentMailboxUser(), messageId));
        } catch (error) {
          if (/stored message|unknown message/i.test(error?.message || '')) {
            throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
          }
          throw error;
        }
      }
      if (body.force != null && typeof body.force !== 'boolean') {
        throw new HttpError(400, 'FORCE_INVALID', 'force must be a boolean.');
      }
      const batchSize = body.batchSize == null ? 250 : Number(body.batchSize);
      const maxMessages = body.maxMessages == null ? 50_000 : Number(body.maxMessages);
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new HttpError(400, 'BATCH_SIZE_INVALID', 'batchSize must be an integer between 1 and 1000.');
      }
      if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100_000) {
        throw new HttpError(400, 'MAX_MESSAGES_INVALID', 'maxMessages must be an integer between 1 and 100000.');
      }
      return json(res, 200, requireMailMemory().classifyStoredPrecision(currentMailboxUser(), {
        force: body.force === true,
        batchSize,
        maxMessages,
      }));
    }

    if (url.pathname === '/api/intelligence/correct') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const messageId = validatedText(body.messageId || '', 'messageId', 500);
      if (!messageId) throw new HttpError(400, 'MESSAGE_ID_REQUIRED', 'messageId is required.');
      try {
        return json(res, 200, requireMailMemory().correctPrecision(currentMailboxUser(), messageId, body));
      } catch (error) {
        if (/unknown message|stored message/i.test(error?.message || '')) {
          throw new HttpError(404, 'MESSAGE_NOT_FOUND', 'Stored message was not found.');
        }
        if (/Invalid precision correction|requires at least one override|must reference an active project/i.test(error?.message || '')) {
          throw new HttpError(400, 'PRECISION_CORRECTION_INVALID', error.message);
        }
        throw error;
      }
    }

    if (url.pathname === '/api/intelligence/search') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const query = validatedText(url.searchParams.get('q') || '', 'q', 500);
      const limit = Number(url.searchParams.get('limit') || 25);
      if (!query) throw new HttpError(400, 'SEARCH_QUERY_REQUIRED', 'q is required.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, 'SEARCH_LIMIT_INVALID', 'limit must be an integer between 1 and 100.');
      }
      try {
        return json(res, 200, requireMailMemory().intelligentSearch(currentMailboxUser(), query, { limit }));
      } catch (error) {
        if (/Intelligent search query/i.test(error?.message || '')) {
          throw new HttpError(400, 'INTELLIGENT_SEARCH_INVALID', error.message);
        }
        throw error;
      }
    }

    if (url.pathname === '/api/storage/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, protectedStorageStatus());
    }

    if (url.pathname === '/api/outlook/sync/status') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      return json(res, 200, requireMailMemory().syncStatus(currentMailboxUser()));
    }

    if (url.pathname === '/api/outlook/sync') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const top = body.top == null ? 50 : Number(body.top);
      if (!Number.isInteger(top) || top < 1 || top > 50) {
        throw new HttpError(400, 'TOP_INVALID', 'top must be an integer between 1 and 50.');
      }
      if (body.forceInitial != null && typeof body.forceInitial !== 'boolean') {
        throw new HttpError(400, 'FORCE_INITIAL_INVALID', 'forceInitial must be a boolean.');
      }
      const syncResult = await fetchOutlookMessages(top, {
        forceInitial: body.forceInitial === true,
      });
      return json(res, 200, syncResult);
    }

    if (url.pathname === '/api/mail/search') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const query = validatedText(url.searchParams.get('q') || '', 'q', 500);
      const limit = Number(url.searchParams.get('limit') || 25);
      if (!query) throw new HttpError(400, 'SEARCH_QUERY_REQUIRED', 'q is required.');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, 'SEARCH_LIMIT_INVALID', 'limit must be an integer between 1 and 100.');
      }
      return json(res, 200, {
        query,
        results: requireMailMemory().search(currentMailboxUser(), query, { limit }),
      });
    }

    if (url.pathname === '/api/storage/backup') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      await readJsonBody(req);
      const backup = await requireMailMemory().backup();
      return json(res, 201, {
        created: true,
        backup: {
          name: backup.manifest.backup_name,
          checksumSha256: backup.checksumSha256,
          sizeBytes: backup.sizeBytes,
          schemaVersion: backup.schemaVersion,
          createdAt: backup.createdAt,
          integrity: backup.validation.ok,
        },
      });
    }

    if (url.pathname === '/api/outlook/send') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      assertMutationAllowed(safetyPolicy, 'mailSend');
      return json(res, 501, { sent: false, code: 'NOT_IMPLEMENTED', message: 'Mail send is not available in v1.1.0.' });
    }

    if (url.pathname === '/api/outlook/read') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      assertMutationAllowed(safetyPolicy, 'mailReadState');
      return json(res, 501, { updated: false, code: 'NOT_IMPLEMENTED', message: 'Read-state mutation is not available in v1.1.0.' });
    }

    if (url.pathname === '/api/outlook/feedback') {
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireStateChange(req);
      const body = await readJsonBody(req);
      const feedback = await saveClassificationFeedback(body);
      return json(res, 200, { saved: true, feedback });
    }

    if (url.pathname === '/api/outlook/messages' || url.pathname === '/api/outlook/analyze') {
      if (req.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      requireSessionCookie(req);
      const top = Number(url.searchParams.get('top') || 25);
      if (!Number.isInteger(top) || top < 1 || top > 50) {
        throw new HttpError(400, 'TOP_INVALID', 'top must be an integer between 1 and 50.');
      }
      const data = await fetchOutlookMessages(top);
      if (url.pathname === '/api/outlook/messages') return json(res, 200, data);
      const { feedback } = await readFeedbackContext();
      const baseResult = applyFeedbackToResult(analyzeMessages(data.messages), data.messages, feedback, { allowLearnedOverride: true });
      let result = baseResult;
      try {
        result = await enrichWithAI(data.messages, baseResult);
        result = applyFeedbackToResult(result, data.messages, feedback, { allowLearnedOverride: false });
      } catch (error) {
        const policyBlocked = ['EXTERNAL_AI_DISABLED', 'EXTERNAL_AI_OPT_IN_REQUIRED'].includes(String(error?.code || ''));
        const ai = policyBlocked
          ? policyBlockedAiRun(error, {
            provider: runtimeConfig.aiProvider,
            model: providerModel(runtimeConfig.aiProvider, runtimeConfig),
          })
          : error?.aiRun || failedAiRun(error, {
            provider: runtimeConfig.aiProvider,
            model: providerModel(runtimeConfig.aiProvider, runtimeConfig),
            attempts: error?.attempts || []
          });
        result = {
          ...baseResult,
          messageInsights: baseResult.messageInsights.map((insight) => ({
            ...insight,
            analysisState: policyBlocked ? 'policy_blocked' : 'degraded',
            aiEnhanced: false
          })),
          ai
        };
      }
      return json(res, 200, {
        ...data,
        analyzedAt: new Date().toISOString(),
        result,
        aiError: result.ai?.status === 'failed' ? result.ai.error : null
      });
    }

    if (url.pathname === '/api/hooks/data-plane' && req.method === 'POST') {
      requireStateChange(req);
      assertMutationAllowed(safetyPolicy, 'dataPlaneWrite');
      return json(res, 501, { ok: false, code: 'NOT_IMPLEMENTED', message: 'Data Plane mutation is not available in v1.1.0.' });
    }

    if (url.pathname === '/api/fixtures/ingest-mail' && req.method === 'POST') {
      requireStateChange(req);
      assertMutationAllowed(safetyPolicy, 'dataPlaneWrite');
      return json(res, 501, { ok: false, code: 'NOT_IMPLEMENTED', message: 'Fixture publication is not available in v1.1.0.' });
    }

    return json(res, 404, { code: 'NOT_FOUND', message: 'Not found.' });
  } catch (error) {
    return json(res, error?.statusCode || 500, {
      code: error?.code === 'MUTATION_DISABLED' ? 'EXTERNAL_ACTION_DISABLED' : error?.code || 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unexpected server error.'
    });
  }
}

const server = createServer(async (req, res) => {
  try {
    assertAllowedHost(req);
  } catch (error) {
    json(res, error.statusCode || 403, {
      code: error.code || 'HOST_NOT_ALLOWED',
      message: error.message || 'Only the local Mail Intelligence origin is allowed.'
    });
    return;
  }

  if ((req.url || '').startsWith('/auth/callback')) {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const error = url.searchParams.get('error_description') || url.searchParams.get('error');
    const pending = pendingOAuth.get(state);
    pendingOAuth.delete(state);

    if (error || !pending || !code || Date.now() - pending.createdAt > OAUTH_STATE_TTL_MS) {
      res.writeHead(400, { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Outlook login failed</h1><p>${escapeHtmlServer(error || 'Invalid or expired OAuth state.')}</p>`);
      return;
    }

    try {
      const tokenParams = {
        client_id: pending.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.codeVerifier,
        scope: delegatedScopes
      };
      if (runtimeConfig.clientSecret) {
        tokenParams.client_secret = runtimeConfig.clientSecret;
      }
      const body = new URLSearchParams(tokenParams);
      const response = await fetchWithTimeout(`https://login.microsoftonline.com/${pending.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      }, 20_000);
      if (!response.ok) {
        await throwUpstreamHttpError(response, 'MICROSOFT_CODE_EXCHANGE_FAILED', 'Microsoft authorization code exchange');
      }
      const payload = await readUpstreamJson(response, 'MICROSOFT_CODE_EXCHANGE_JSON_INVALID', 'Microsoft authorization code exchange');
      runtimeConfig.accessToken = payload.access_token || '';
      runtimeConfig.refreshToken = payload.refresh_token || '';
      runtimeConfig.clientId = pending.clientId;
      runtimeConfig.tenantId = pending.tenantId;
      runtimeConfig.loginTenant = pending.tenantId;
      runtimeConfig.mailboxUser = pending.mailboxUser;
      runtimeConfig.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
      await savePersistedConfig();
      res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Outlook login complete</h1><p>이 창을 닫고 Mail Intelligence 화면에서 Outlook 가져오기를 누르세요.</p>');
    } catch (exchangeError) {
      res.writeHead(502, { ...securityHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h1>Outlook token exchange failed</h1><p>${escapeHtmlServer(exchangeError instanceof Error ? exchangeError.message : 'Unknown error')}</p>`);
    }
    return;
  }

  if ((req.url || '').startsWith('/api/')) {
    await handleApi(req, res);
    return;
  }

  if (!['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
    json(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Static content is read-only.' });
    return;
  }

  if (!requirePageAccess(req, res)) return;

  try {
    const filePath = await resolveStaticFile(root, req.url || '/');
    const body = await readFile(filePath);
    res.writeHead(200, {
      ...securityHeaders(),
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Content-Length': body.length
    });
    if (String(req.method || 'GET').toUpperCase() === 'HEAD') res.end();
    else res.end(body);
  } catch (error) {
    json(res, error?.statusCode || 404, {
      code: error?.statusCode === 403 ? 'STATIC_PATH_REJECTED' : error?.statusCode === 400 ? 'STATIC_PATH_INVALID' : 'STATIC_NOT_FOUND',
      message: error instanceof Error ? error.message : 'Static file was not found.'
    });
  }
});

server.on('error', async (error) => {
  if (error && error.code === 'EADDRINUSE') {
    try {
      const response = await fetchWithTimeout(`${localBaseUrl}/api/health`);
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
        console.log(`Mail Intelligence is already running at ${localBaseUrl}`);
        mailMemory?.close();
        mailMemory = null;
        process.exit(0);
      }
    } catch {
      // Fall through to the generic port-in-use guidance below.
    }
    console.error(`Port ${port} on ${host} is already in use by another process. Stop it or run with PORT=${port + 1} npm run dev.`);
    process.exit(1);
  }
  throw error;
});

await ensurePrivateDirectory(dataRoot);
await loadPersistedConfig();
mailMemory = new PersistentMailMemoryRuntime({
  databasePath,
  migrationsDir: join(appRoot, 'migrations'),
  backupDirectory,
  legacyCachePaths: [mailCachePath, legacyMailCachePath],
  graphBaseUrl,
  graphTimeoutMs: Math.max(Number(process.env.MAIL_INTELLIGENCE_GRAPH_TIMEOUT_MS || 30_000), 1_000),
  graphPageSize: Math.min(Math.max(Number(process.env.MAIL_INTELLIGENCE_GRAPH_PAGE_SIZE || 50), 1), 100),
  graphMaxPages: Math.min(Math.max(Number(process.env.MAIL_INTELLIGENCE_GRAPH_MAX_PAGES || 1_000), 1), 10_000),
  attachmentMetadataLimit: Math.min(
    Math.max(Number(process.env.MAIL_INTELLIGENCE_ATTACHMENT_METADATA_LIMIT || 10), 0),
    50,
  ),
});
const mailMemoryInitialization = await mailMemory.initialize();
mailMemoryHealth = {
  ready: mailMemoryInitialization.storage.ready,
  schemaVersion: mailMemoryInitialization.storage.schemaVersion,
  sizeBytes: mailMemoryInitialization.storage.sizeBytes,
};

let shutdownStarted = false;
function closePersistentMailMemory() {
  if (!mailMemory) return;
  mailMemory.close();
  mailMemory = null;
}

function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close(() => {
    closePersistentMailMemory();
    process.exit(0);
  });
  setTimeout(() => {
    closePersistentMailMemory();
    process.exit(1);
  }, 5_000).unref();
  console.log(`Mail Intelligence received ${signal}; closing persistent mail memory.`);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

server.listen(port, host, () => {
  console.log(`Mail Intelligence ${APP_VERSION} app running at ${localBaseUrl}`);
  console.log(`[storage] SQLite schema v${mailMemoryInitialization.storage.schemaVersion} ready.`);
});

// --- AI Helper Functions ---

function buildAnalysisPrompt(feedbackExamples, messagesForAi) {
  return `You are a cautious executive email intelligence assistant. Return ONLY valid JSON.

Prompt version: ${AI_PROMPT_VERSION}
Language: Korean.
Classify each email as one of: urgent, active, waiting, done, reference.
Use the current request and future obligation over historical completion wording.
A reference/no-action email must not receive a reply draft unless the email contains explicit contradictory evidence.
Provide one primary next action. Add at most two alternatives only when they materially differ.
For urgent, active, or waiting, return 1-3 nextActions. For done or reference, return an empty nextActions array.
Do not force a reply. Valid actionType values are: draft_reply, request_info, share_document, review, archive, monitor, create_task.
Do not invent a person, project, product, date, amount, attachment, or decision.
Every important status or action must cite an exact short evidence sentence that appears in the supplied email source.
Confidence is required as a JSON number from 0 to 1. Lower it when evidence is incomplete or conflicting.
If evidence is insufficient, lower the recommendation to review/monitor and describe the uncertainty.
User corrections are preference evidence, but explicit current-email evidence takes precedence.

Recent user correction examples:
${JSON.stringify(feedbackExamples, null, 2)}

JSON schema:
{
  "messages": [
    {
      "id": "same id",
      "status": "urgent|active|waiting|done|reference",
      "confidence": 0.0,
      "summary": ["2-4 concise Korean bullets"],
      "nextActions": [
        {
          "actionType": "draft_reply|request_info|share_document|review|archive|monitor|create_task",
          "title": "short action title",
          "recommendedAction": "concrete Korean action",
          "owner": "owner explicitly found in email or 미지정",
          "due": "explicit due date/time or empty",
          "priority": 1,
          "lane": "urgent|active|waiting|done|reference",
          "evidence": "short supporting sentence from email",
          "intent": "why this action is useful",
          "to": "recipient email only for a draft",
          "subject": "draft email subject only for a draft",
          "body": "editable Korean draft only for a draft"
        }
      ],
      "evidenceItems": ["short supporting facts from the email"],
      "aiRationale": "reasoning summary and uncertainty, without hidden chain of thought"
    }
  ]
}

Emails:
${JSON.stringify(messagesForAi.map((message) => ({
    id: message.id,
    subject: message.subject,
    from: message.fromName || message.from,
    receivedAt: message.receivedAt,
    body: clip(message.body || message.bodyPreview, 4500),
  })), null, 2)}`;
}

async function testOAuthProvider(provider, model) {
  assertCapability(safetyPolicy, 'externalAi');
  if (runtimeConfig.aiOptInVersion !== AI_OPT_IN_VERSION) {
    throw new HttpError(403, 'EXTERNAL_AI_OPT_IN_REQUIRED', 'OAuth LLM data-policy acceptance is required.');
  }
  const source = 'OAuth provider connection test. No real email content is included.';
  const prompt = `${buildAnalysisPrompt([], [{
    id: 'oauth-test-message',
    subject: 'OAuth provider connection test',
    from: 'system@localhost',
    receivedAt: new Date(0).toISOString(),
    body: source,
    bodyPreview: source,
  }])}
This is a synthetic connectivity test. Return status reference, no nextActions, and quote the exact source sentence as evidence.`;
  const result = await runOAuthCliProvider(provider, prompt, {
    model,
    configuredPath: oauthCliConfiguredPath(provider),
    schemaPath: join(appRoot, 'schemas', 'mail-analysis.schema.json'),
    timeoutMs: 120_000,
  });
  const parsed = parseAiAnalysis(result.text, {
    expectedMessageIds: ['oauth-test-message'],
    sourceTextById: { 'oauth-test-message': `OAuth provider connection test
${source}` },
  });
  return {
    ok: true,
    provider,
    model: result.model,
    messageCount: parsed.messages.length,
    evidenceVerified: parsed.messages.every((item) => item.evidenceVerified === true),
  };
}
