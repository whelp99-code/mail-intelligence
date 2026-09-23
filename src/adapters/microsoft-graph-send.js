import {
  assertMailSendRecipientsAllowed,
  normalizeMailSendRecipientAllowlist,
} from '../security/mail-send-recipient-policy.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const CORRELATION_HEADER = 'x-mi-draft-id';

function fail(code, statusCode = 403) {
  const error = new Error(code);
  Object.assign(error, { code, statusCode });
  throw error;
}

// This is a fail-closed preflight, not token signature verification. Graph is
// the authority validating the token and granting the actual permission.
export function hasMailSendScope(token, now = Date.now()) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return false;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return false;
    return String(claims.scp || '').split(' ').includes('Mail.Send');
  } catch {
    return false;
  }
}

function mailboxPath(user) {
  if (!user || user === 'me') return '/me';
  if (typeof user !== 'string' || user.length > 254 || /\s/.test(user) || [...user].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) fail('INVALID_SEND_MAILBOX', 400);
  return `/users/${encodeURIComponent(user)}`;
}

function recipientAddresses(values) {
  if (!Array.isArray(values)) return null;
  return values.map((value) => String(value?.emailAddress?.address || '').toLowerCase()).sort();
}

function equalAddresses(actual, expected) {
  const addresses = recipientAddresses(actual);
  return addresses !== null && JSON.stringify(addresses) === JSON.stringify([...expected].map((value) => value.toLowerCase()).sort());
}

function sameBody(actual, expected) {
  return typeof actual === 'string' && actual.replace(/\r\n/g, '\n').trim() === expected.replace(/\r\n/g, '\n').trim();
}

export class GraphSendClient {
  constructor({
    accessToken, mailboxUser = 'me', fetchImpl = globalThis.fetch, timeoutMs = 20000, maxPages = 20,
    recipientAllowlist = null,
  }) {
    this.accessToken = accessToken;
    this.path = mailboxPath(mailboxUser);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(10, Math.min(Number(timeoutMs) || 20000, 60000));
    this.maxPages = Math.max(1, Math.min(Number(maxPages) || 20, 100));
    this.recipientAllowlist = normalizeMailSendRecipientAllowlist(recipientAllowlist);
  }

  async request(url, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (method === 'POST' || !response.ok) {
        await response.body?.cancel();
        return { status: response.status, payload: null };
      }
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      let part = await reader.read();
      while (!part.done) {
        const { value } = part;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          fail('GRAPH_RECEIPT_TOO_LARGE', 502);
        }
        chunks.push(Buffer.from(value));
        part = await reader.read();
      }
      return { status: response.status, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendOnce(draft, { allowSend = false } = {}) {
    if (allowSend !== true) fail('MAIL_SEND_DISABLED');
    if (!hasMailSendScope(this.accessToken)) fail('MAIL_SEND_SCOPE_REQUIRED');
    if (draft.status !== 'sending' || !draft.approved_at || !draft.approved_by?.startsWith('session:')) fail('HUMAN_APPROVAL_REQUIRED');
    if (!/^[0-9a-f-]{36}$/.test(draft.draft_id) || !draft.to?.length || !draft.subject || !draft.body_text) fail('INVALID_SEND_DRAFT', 400);
    assertMailSendRecipientsAllowed(this.recipientAllowlist, draft);
    const message = {
      subject: draft.subject,
      body: { contentType: 'Text', content: draft.body_text },
      toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: draft.cc.map((address) => ({ emailAddress: { address } })),
      internetMessageHeaders: [{ name: CORRELATION_HEADER, value: draft.draft_id }],
    };
    let response;
    try {
      response = await this.request(`${GRAPH_ROOT}${this.path}/sendMail`, { method: 'POST', body: { message, saveToSentItems: true } });
    } catch {
      return { uncertain: true, failureCode: 'GRAPH_ACCEPTANCE_UNKNOWN' };
    }
    if (response.status !== 202) {
      const uncertain = response.status < 400 || response.status >= 500 || response.status === 408;
      return { uncertain, failureCode: uncertain ? 'GRAPH_ACCEPTANCE_UNKNOWN' : 'GRAPH_SEND_REJECTED' };
    }
    return this.reconcile(draft);
  }

  async reconcile(draft) {
    if (!this.accessToken || draft.status !== 'sending' || !Number.isFinite(Date.parse(draft.approved_at))) {
      return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
    }
    const prefix = `${GRAPH_ROOT}${this.path}/mailFolders/sentitems/messages`;
    const url = new URL(prefix);
    url.searchParams.set('$select', 'id,subject,body,toRecipients,ccRecipients,internetMessageHeaders,sentDateTime,isDraft');
    url.searchParams.set('$filter', `sentDateTime ge ${new Date(Date.parse(draft.approved_at) - 300000).toISOString()}`);
    url.searchParams.set('$top', '50');
    let next = url.toString();
    const seen = new Set();
    const matched = [];
    let pages = 0;
    try {
      while (next) {
        const continuation = new URL(next);
        if (continuation.origin !== 'https://graph.microsoft.com' || continuation.pathname !== new URL(prefix).pathname || continuation.username || continuation.password || continuation.hash || seen.has(next) || pages++ >= this.maxPages) {
          return { uncertain: true, failureCode: 'GRAPH_RECEIPT_SCAN_INCOMPLETE' };
        }
        seen.add(next);
        const response = await this.request(next);
        if (response.status !== 200 || !Array.isArray(response.payload?.value)) return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
        for (const message of response.payload.value) {
          const headers = (Array.isArray(message.internetMessageHeaders) ? message.internetMessageHeaders : [])
            .filter((header) => String(header.name).toLowerCase() === CORRELATION_HEADER);
          if (!headers.some((header) => header.value === draft.draft_id)) continue;
          if (headers.length !== 1 || message.isDraft !== false || !message.id || typeof message.id !== 'string' || !Number.isFinite(Date.parse(message.sentDateTime)) || Date.parse(message.sentDateTime) < Date.parse(draft.approved_at) - 60000 || message.subject !== draft.subject || String(message.body?.contentType).toLowerCase() !== 'text' || !sameBody(message.body?.content, draft.body_text) || !equalAddresses(message.toRecipients, draft.to) || !equalAddresses(message.ccRecipients, draft.cc)) {
            return { uncertain: true, failureCode: 'GRAPH_RECEIPT_PAYLOAD_MISMATCH' };
          }
          matched.push(message);
        }
        next = response.payload['@odata.nextLink'] || '';
        if (typeof next !== 'string') return { uncertain: true, failureCode: 'GRAPH_RECEIPT_SCAN_INCOMPLETE' };
      }
    } catch {
      return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
    }
    if (matched.length !== 1) return { uncertain: true, failureCode: matched.length > 1 ? 'GRAPH_RECEIPT_AMBIGUOUS' : 'GRAPH_RECEIPT_PENDING' };
    return { graphMessageId: matched[0].id, sentAt: matched[0].sentDateTime };
  }
}
