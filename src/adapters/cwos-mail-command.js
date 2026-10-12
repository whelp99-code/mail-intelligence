import { createHash } from 'node:crypto';

function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function text(value) {
  if (typeof value !== 'string' || !value.trim()) fail('CWOS_MAIL_INPUT_INVALID', 400);
  return value;
}

export function mailSourceDigest(source) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  const revision = { ...source };
  delete revision.observedAt;
  return createHash('sha256').update(JSON.stringify(canonical(revision))).digest('hex');
}

/** Explicit native actor binding; no environment lookup or background activation. */
export class CwosMailCommandClient {
  constructor({ baseUrl, apiKey, workspaceId, principalId, kind, fetchImpl = globalThis.fetch }) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !['http:', 'https:'].includes(url.protocol)) fail('CWOS_MAIL_BINDING_INVALID');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      fail('CWOS_MAIL_BINDING_INVALID');
    }
    if (!['ai', 'service', 'human'].includes(kind)) fail('CWOS_MAIL_BINDING_INVALID');
    this.origin = url.origin;
    this.apiKey = text(apiKey);
    this.workspaceId = text(workspaceId);
    this.principalId = text(principalId);
    this.kind = kind;
    this.fetchImpl = fetchImpl;
  }

  async readState(workspaceId) {
    this.assertScope(workspaceId);
    const state = await this.request('GET', '/api/cwos/v2/state');
    if (state.workspaceId !== workspaceId) fail('CWOS_RESPONSE_SCOPE_MISMATCH');
    return state;
  }

  assertScope(workspaceId) {
    if (workspaceId !== this.workspaceId) fail('CWOS_WORKSPACE_NOT_BOUND');
  }

  sourceFields(workspaceId, source, mailboxUser) {
    this.assertScope(workspaceId);
    text(source.messageId);
    text(source.revision);
    text(source.receivedAt);
    if (!Number.isFinite(Date.parse(source.receivedAt))) fail('CWOS_MAIL_INPUT_INVALID', 400);
    const sourceKey = createHash('sha256').update(JSON.stringify({
      workspaceId, mailbox: text(mailboxUser), sourceDigest: mailSourceDigest(source),
    })).digest('hex');
    return {
      provider: 'OUTLOOK', mailbox: text(mailboxUser), sourceLocator: source.messageId,
      sourceEventId: `mail-source:${sourceKey}`,
    };
  }

  async receive({ workspaceId, source, mailboxUser, message, expectedVersion, assertCurrent }) {
    const fields = this.sourceFields(workspaceId, source, mailboxUser);
    const payload = {
      id: `mail-receipt:${fields.sourceEventId}`,
      provider: fields.provider, mailbox: fields.mailbox, sourceLocator: fields.sourceLocator,
      providerEventId: fields.sourceEventId, receivedAt: source.receivedAt,
      event: {
        id: fields.sourceEventId, occurredAt: source.receivedAt,
        subject: text(message.subject), sender: text(message.from),
        bodyDigest: createHash('sha256').update(message.body || message.bodyPreview || '').digest('hex'),
        promptInjectionSuspected: message.promptInjectionSuspected === true,
      },
    };
    return this.command('mail.inbox.receive', payload, expectedVersion, assertCurrent);
  }

  async mapWork({ workspaceId, source, mailboxUser, workItemId, correctionReason, expectedVersion, assertCurrent }) {
    this.assertScope(workspaceId);
    if (this.kind !== 'human') fail('CWOS_HUMAN_HANDOFF_REQUIRED');
    const fields = this.sourceFields(workspaceId, source, mailboxUser);
    const payload = {
      ...fields,
      id: `mail-link:${fields.sourceEventId}:${text(workItemId)}:${createHash('sha256').update(text(correctionReason)).digest('hex')}`,
      workItemId, correctionReason: text(correctionReason),
    };
    return this.command('mail.mapWork', payload, expectedVersion, assertCurrent);
  }

  async command(command, payload, expectedVersion, assertCurrent) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('CWOS_MAIL_INPUT_INVALID', 400);
    if (typeof assertCurrent !== 'function') fail('CWOS_SOURCE_CHECK_REQUIRED');
    assertCurrent();
    const idempotencyKey = `mail-command:${createHash('sha256').update(JSON.stringify({ command, payload })).digest('hex')}`;
    const result = await this.request('POST', '/api/cwos/v2/commands', { command, payload, expectedVersion }, idempotencyKey);
    if (!result.result || !/^[0-9a-f]{64}$/.test(result.stateHash) || !Number.isSafeInteger(result.runtimeVersion)
      || result.result.id !== payload.id) fail('CWOS_MAIL_RECEIPT_MISMATCH', 502);
    if (result.result.workspaceId !== this.workspaceId) fail('CWOS_RESPONSE_SCOPE_MISMATCH', 502);
    for (const key of ['provider', 'mailbox', 'sourceLocator']) {
      if (result.result[key] !== payload[key]) fail('CWOS_MAIL_RECEIPT_MISMATCH', 502);
    }
    const eventKey = command === 'mail.inbox.receive' ? 'providerEventId' : 'sourceEventId';
    if (result.result[eventKey] !== payload[eventKey]) fail('CWOS_MAIL_RECEIPT_MISMATCH', 502);
    const targetKey = command === 'mail.inbox.receive' ? 'receivedAt' : 'workItemId';
    if (result.result[targetKey] !== payload[targetKey]) fail('CWOS_MAIL_RECEIPT_MISMATCH', 502);
    return { ...result, idempotencyKey, command, payload };
  }

  async request(method, path, body, idempotencyKey) {
    const response = await this.fetchImpl(new URL(path, this.origin), {
      method, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: {
        'x-api-key': this.apiKey, 'x-workspace-id': this.workspaceId,
        'x-principal-id': this.principalId, 'x-principal-kind': this.kind,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status >= 300 && response.status < 400
      || response.url && new URL(response.url).origin !== this.origin) fail('CWOS_CREDENTIAL_REDIRECT', 502);
    const result = await response.json();
    if (response.status !== 200) fail(result.error || 'CWOS_COMMAND_FAILED', response.status);
    return result;
  }
}
