import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { mailSourceDigest } from './cwos-mail-command.js';
import { normalizeCwosPrincipalId, resolveCwosCredentialFile } from './cwos-credential-identity.js';

function fail(code, statusCode = 502) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function bounded(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function candidateIdentity(payload) {
  const occurrence = String(payload.providerEventId || '').slice('mail-source:'.length);
  const crmId = `mail-candidate-${createHash('sha256').update(JSON.stringify(stableJson({
    mailbox: payload.mailbox,
    provider: payload.provider,
    providerEventId: payload.providerEventId,
    workspaceId: payload.workspaceId,
  }))).digest('hex')}`;
  return { occurrence, occurrenceId: `mail-candidate-${occurrence}`, crmId };
}

function confirmsPayload(item, payload, identity) {
  if (!item || typeof item !== 'object') return false;
  const identified = item.id === identity.occurrenceId
    || item.id === identity.crmId
    || item.providerEventId === payload.providerEventId;
  if (!identified || item.bodyDigest !== payload.bodyDigest) return false;
  if (item.providerEventId != null && item.providerEventId !== payload.providerEventId) return false;
  if (item.workspaceId != null && item.workspaceId !== payload.workspaceId) return false;
  for (const key of ['provider', 'mailbox', 'sourceLocator', 'subject']) {
    if (item[key] != null && item[key] !== payload[key]) return false;
  }
  if (item.status != null && item.status !== 'CANDIDATE') return false;
  if (item.confirmed != null && item.confirmed !== false) return false;
  if (item.freshness != null && item.freshness !== 'producer_unverified') return false;
  const id = /^mail-candidate-[a-f0-9]{64}$/.test(item.id || '') ? item.id : identity.occurrenceId;
  return /^mail-candidate-[a-f0-9]{64}$/.test(id);
}

export async function loadCwosMailCandidateWriter(env = {}, {
  fetchImpl = globalThis.fetch, statImpl = lstat, readFileImpl = readFile, realpathImpl = realpath,
} = {}) {
  const flag = env.MAIL_INTELLIGENCE_CWOS_CANDIDATES_ENABLED;
  if (flag === '0') return null;
  const fields = ['BASE_URL', 'KEY_FILE', 'PRINCIPAL_ID']
    .map(name => env[`MAIL_INTELLIGENCE_CWOS_CANDIDATE_WRITER_${name}`]);
  if (!flag && fields.every(value => !value)) return null;
  const principalId = normalizeCwosPrincipalId(fields[2]);
  if (flag !== '1' || fields.some(value => !value) || !principalId || !String(fields[1]).trim()) {
    fail('CWOS_CANDIDATE_CONFIG_INVALID', 500);
  }
  if (principalId === normalizeCwosPrincipalId(env.MAIL_INTELLIGENCE_CWOS_PRINCIPAL_ID)) {
    fail('CWOS_CANDIDATE_READER_CREDENTIAL_REUSE', 500);
  }
  const writer = await resolveCwosCredentialFile(fields[1], { realpathImpl, statImpl });
  const { metadata } = writer;
  const readerFile = String(env.MAIL_INTELLIGENCE_CWOS_API_KEY_FILE || '').trim();
  if (readerFile) {
    const reader = await resolveCwosCredentialFile(readerFile, { realpathImpl, statImpl });
    if (writer.path === reader.path || (metadata.dev != null && metadata.ino != null
      && metadata.dev === reader.metadata.dev && metadata.ino === reader.metadata.ino)) {
      fail('CWOS_CANDIDATE_READER_CREDENTIAL_REUSE', 500);
    }
  }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) fail('CWOS_CANDIDATE_CONFIG_INVALID', 500);
  return new CwosMailCandidateWriter({
    baseUrl: fields[0], apiKey: String(await readFileImpl(writer.path, 'utf8')).trim(),
    principalId, workspaceId: env.MAIL_INTELLIGENCE_INTAKE_WORKSPACE,
    mailbox: env.MAIL_INTELLIGENCE_INTAKE_EXPECTED_EMAIL, fetchImpl,
  });
}

/** Separate, opt-in create-only key: never uses the generic CRM command port. */
export class CwosMailCandidateWriter {
  constructor({ baseUrl, apiKey, workspaceId, principalId, mailbox, fetchImpl = globalThis.fetch }) {
    let url;
    try { url = new URL(baseUrl); } catch { fail('CWOS_CANDIDATE_CONFIG_INVALID', 500); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['http:', 'https:'].includes(url.protocol)
      || (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      || !bounded(workspaceId, 200) || /\s/.test(workspaceId)
      || !bounded(principalId, 200) || /\s/.test(principalId)
      || !bounded(mailbox, 254) || !/^[^@\s]+@[^@\s]+$/.test(mailbox)
      || !bounded(apiKey, 4096) || apiKey.length < 32 || /\s/.test(apiKey)
      || typeof fetchImpl !== 'function') fail('CWOS_CANDIDATE_CONFIG_INVALID', 500);
    this.origin = url.origin;
    this.apiKey = apiKey;
    this.workspaceId = workspaceId;
    this.principalId = principalId;
    this.mailbox = mailbox.toLowerCase();
    this.fetchImpl = fetchImpl;
  }

  async create({ workspaceId, source, message, expectedVersion, assertCurrent }) {
    if (workspaceId !== this.workspaceId) fail('CWOS_WORKSPACE_NOT_BOUND', 403);
    if (typeof assertCurrent !== 'function') fail('CWOS_SOURCE_CHECK_REQUIRED', 403);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || !bounded(source?.messageId, 1000) || !bounded(source?.revision, 500)
      || !bounded(message?.subject, 500) || message.id !== source.messageId
      || typeof message.body !== 'string') fail('CWOS_CANDIDATE_INPUT_INVALID', 400);
    const occurrence = mailSourceDigest({ workspaceId, mailbox: this.mailbox, sourceDigest: mailSourceDigest(source) });
    const payload = {
      expectedVersion, workspaceId, provider: 'OUTLOOK', mailbox: this.mailbox,
      sourceLocator: source.messageId, providerEventId: `mail-source:${occurrence}`,
      subject: message.subject.trim(),
      bodyDigest: createHash('sha256').update(message.body).digest('hex'),
    };
    const idempotencyKey = `mail-candidate:${occurrence}`;
    assertCurrent();
    let response;
    try {
      response = await this.fetchImpl(new URL('/api/cwos/v2/mail-candidates', this.origin), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: {
          'x-api-key': this.apiKey, 'x-workspace-id': this.workspaceId,
          'x-principal-id': this.principalId, 'x-principal-kind': 'service',
          'content-type': 'application/json', 'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch { fail('CWOS_CANDIDATE_UNAVAILABLE'); }
    if (response.status >= 300 && response.status < 400) fail('CWOS_CREDENTIAL_REDIRECT');
    if (response.url && new URL(response.url).origin !== this.origin) fail('CWOS_CREDENTIAL_REDIRECT');
    if (response.status === 409) {
      const confirmed = await this.lookupConfirmedCandidate(payload, expectedVersion);
      if (!confirmed) fail('CWOS_CANDIDATE_CONFLICT');
      assertCurrent();
      return confirmed;
    }
    if (response.status !== 201) fail('CWOS_CANDIDATE_DENIED');
    let result;
    try { result = await response.json(); } catch { fail('CWOS_CANDIDATE_RESPONSE_INVALID'); }
    const item = result?.candidate;
    if (!item || !/^mail-candidate-[a-f0-9]{64}$/.test(item.id || '')
      || item.workspaceId !== this.workspaceId || item.createdByPrincipalId !== this.principalId
      || item.status !== 'CANDIDATE' || item.confirmed !== false
      || item.freshness !== 'producer_unverified' || item.version !== 1
      || !Number.isSafeInteger(result.runtimeVersion) || result.runtimeVersion < expectedVersion
      || ['provider', 'mailbox', 'sourceLocator', 'providerEventId', 'subject', 'bodyDigest']
        .some(key => item[key] !== payload[key])) fail('CWOS_CANDIDATE_RECEIPT_MISMATCH');
    assertCurrent();
    return { id: item.id, runtimeVersion: result.runtimeVersion, idempotencyKey };
  }

  async lookupConfirmedCandidate(payload, expectedVersion) {
    const identity = candidateIdentity(payload);
    if (!/^[a-f0-9]{64}$/.test(identity.occurrence)) return null;
    let response;
    try {
      response = await this.fetchImpl(new URL('/api/cwos/v2/mail-candidates', this.origin), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: {
          accept: 'application/json',
          'x-api-key': this.apiKey, 'x-workspace-id': this.workspaceId,
          'x-principal-id': this.principalId, 'x-principal-kind': 'service',
        },
      });
    } catch { return null; }
    if (response.status >= 300 && response.status < 400) fail('CWOS_CREDENTIAL_REDIRECT');
    if (response.url && new URL(response.url).origin !== this.origin) fail('CWOS_CREDENTIAL_REDIRECT');
    if (response.status !== 200) return null;
    let body;
    try { body = await response.json(); } catch { return null; }
    if (body?.workspaceId !== this.workspaceId || !Array.isArray(body.candidates)) return null;
    const reported = body.runtimeVersion;
    if (reported != null && (!Number.isSafeInteger(reported) || reported < expectedVersion)) return null;
    const item = body.candidates.find(candidate => confirmsPayload(candidate, payload, identity));
    if (!item) return null;
    if (item.createdByPrincipalId != null && item.createdByPrincipalId !== this.principalId) return null;
    const id = /^mail-candidate-[a-f0-9]{64}$/.test(item.id || '') ? item.id : identity.occurrenceId;
    return {
      id,
      runtimeVersion: Number.isSafeInteger(reported) ? reported : expectedVersion,
      idempotencyKey: `mail-candidate:${identity.occurrence}`,
    };
  }
}
