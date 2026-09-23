import {
  assertMailSendRecipientsAllowed,
  normalizeMailSendRecipientAllowlist,
} from '../security/mail-send-recipient-policy.js';
import { createHash } from 'node:crypto';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const CORRELATION_HEADER = 'x-mi-draft-id';
const MESSAGE_READ_LIMIT = 2 * 1024 * 1024;
const ATTACHMENT_READ_LIMIT = Math.floor(3.5 * 1024 * 1024);

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

  async request(url, { method = 'GET', body, maxBytes = MESSAGE_READ_LIMIT, binary = false } = {}) {
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
        if (size > maxBytes) {
          await reader.cancel();
          fail('GRAPH_RECEIPT_TOO_LARGE', 502);
        }
        chunks.push(Buffer.from(value));
        part = await reader.read();
      }
      const raw = Buffer.concat(chunks);
      return { status: response.status, payload: binary ? raw : JSON.parse(raw.toString('utf8')) };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendOnce(draft, { allowSend = false, attachments = [] } = {}) {
    if (allowSend !== true) fail('MAIL_SEND_DISABLED');
    if (!hasMailSendScope(this.accessToken)) fail('MAIL_SEND_SCOPE_REQUIRED');
    if (draft.status !== 'sending' || !draft.approved_at || !draft.approved_by?.startsWith('session:')) fail('HUMAN_APPROVAL_REQUIRED');
    if (!/^[0-9a-f-]{36}$/.test(draft.draft_id) || !draft.to?.length || !draft.subject || !draft.body_text) fail('INVALID_SEND_DRAFT', 400);
    assertMailSendRecipientsAllowed(this.recipientAllowlist, draft);
    const expected = Array.isArray(draft.attachments) ? draft.attachments : [];
    if (expected.length && (!Array.isArray(attachments) || attachments.length !== expected.length)) fail('INVALID_SEND_DRAFT', 400);
    const message = {
      subject: draft.subject,
      body: { contentType: 'Text', content: draft.body_text },
      toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: draft.cc.map((address) => ({ emailAddress: { address } })),
      internetMessageHeaders: [{ name: CORRELATION_HEADER, value: draft.draft_id }],
    };
    if (attachments.length) {
      message.attachments = attachments.map((item) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: item.name,
        contentType: item.mime,
        contentBytes: Buffer.from(item.bytes).toString('base64'),
      }));
    }
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
    const expected = Array.isArray(draft.attachments) ? draft.attachments : [];
    if (expected.length) {
      const files = await this.readSentAttachments(matched[0].id);
      if (files.uncertain) return files;
      if (!sameAttachmentReceipt(expected, files.items)) {
        return { uncertain: true, failureCode: 'GRAPH_RECEIPT_PAYLOAD_MISMATCH' };
      }
    }
    return { graphMessageId: matched[0].id, sentAt: matched[0].sentDateTime };
  }

  async readSentAttachments(messageId) {
    const prefix = `${GRAPH_ROOT}${this.path}/mailFolders/sentitems/messages/${encodeURIComponent(messageId)}/attachments`;
    const items = [];
    const seen = new Set();
    let next = `${prefix}?$select=id,name,contentType,size,isInline&$top=50`;
    let pages = 0;
    try {
      while (next) {
        const continuation = new URL(next);
        if (continuation.origin !== 'https://graph.microsoft.com' || continuation.pathname !== new URL(prefix).pathname || continuation.username || continuation.password || continuation.hash || seen.has(next) || pages++ >= this.maxPages) {
          return { uncertain: true, failureCode: 'GRAPH_RECEIPT_SCAN_INCOMPLETE' };
        }
        seen.add(next);
        const response = await this.request(next, { maxBytes: ATTACHMENT_READ_LIMIT });
        if (response.status !== 200 || !Array.isArray(response.payload?.value)) {
          return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
        }
        for (const item of response.payload.value) {
          if (item.isInline) return { uncertain: true, failureCode: 'GRAPH_RECEIPT_PAYLOAD_MISMATCH' };
          if (!item.id || typeof item.id !== 'string') return { uncertain: true, failureCode: 'GRAPH_RECEIPT_PAYLOAD_MISMATCH' };
          const content = await this.request(`${prefix}/${encodeURIComponent(item.id)}/$value`, {
            maxBytes: ATTACHMENT_READ_LIMIT,
            binary: true,
          });
          if (content.status !== 200 || !Buffer.isBuffer(content.payload)) {
            return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
          }
          items.push({
            name: item.name,
            mime: item.contentType,
            size: content.payload.length,
            sha256: createHash('sha256').update(content.payload).digest('hex'),
          });
        }
        next = response.payload['@odata.nextLink'] || '';
        if (typeof next !== 'string') return { uncertain: true, failureCode: 'GRAPH_RECEIPT_SCAN_INCOMPLETE' };
      }
    } catch {
      return { uncertain: true, failureCode: 'GRAPH_RECEIPT_UNAVAILABLE' };
    }
    return { items };
  }
}

function sameAttachmentReceipt(expected, actual) {
  if (expected.length !== actual.length) return false;
  const sortKey = (item) => `${item.name}|${item.size}|${item.sha256}`;
  const left = [...expected].map((item) => ({
    name: item.name,
    size: Number(item.size),
    sha256: item.sha256,
  })).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const right = [...actual].map((item) => ({
    name: item.name,
    size: Number(item.size),
    sha256: item.sha256,
  })).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return JSON.stringify(left) === JSON.stringify(right);
}
