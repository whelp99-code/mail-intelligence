import { createHash } from 'node:crypto';
import { GraphSendClient, hasMailSendScope } from '../adapters/microsoft-graph-send.js';

export const INQUIRY_NOTIFY_RECIPIENT = 'jm.park@blro.co.kr';
export const INQUIRY_NOTIFY_TEST_BAND = 'inquiry-notification-test-band-only';
export const INQUIRY_NOTIFY_PRODUCTION_BLOCKERS = Object.freeze([
  'persistent-inquiry-id-dedup',
  'uncertain-case-reconciliation',
  'approval-boundary',
]);

const INQUIRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const RECEIVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const GRAPH_HOST = 'graph.microsoft.com';
const harnessLedger = new Map();

function hasControlCharacter(text, allowLineBreaks = false) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (allowLineBreaks && (codePoint === 10 || codePoint === 13)) continue;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function envelope(fields = {}) {
  return {
    sent: false,
    accepted: false,
    confirmed: false,
    resendBlocked: false,
    ...fields,
    contract: INQUIRY_NOTIFY_TEST_BAND,
    harnessOnly: true,
    productionConnected: false,
    serverWired: false,
    productionBlockers: [...INQUIRY_NOTIFY_PRODUCTION_BLOCKERS],
    retryable: false,
    unsentConfirmed: false,
  };
}

function failure(code, fields = {}) {
  return envelope({ failureCode: code, ...fields });
}

function singleLine(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || hasControlCharacter(text)) return null;
  return text;
}

function inquiryBody(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 4000 || hasControlCharacter(text, true)) return null;
  return text;
}

function receivedAt(value) {
  if (typeof value !== 'string' || !RECEIVED_AT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function notificationText(inquiry) {
  const name = singleLine(inquiry?.name, 80);
  const contact = singleLine(inquiry?.contact, 120);
  const body = inquiryBody(inquiry?.body);
  const at = receivedAt(inquiry?.receivedAt);
  if (!name || !contact || !body || !at) return null;
  return [
    `이름: ${name}`,
    `연락처: ${contact}`,
    `문의 본문: ${body}`,
    `접수 시각: ${at}`,
  ].join('\n');
}

function storeHandle(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set);
}

const FIXED_BAND_SENT_AT = '2026-11-08T02:08:01.000Z';
const fixedBandReceipts = new Map();

function refuseLiveGraph() {
  const error = new Error('INQUIRY_NOTIFY_LIVE_GRAPH_REFUSED');
  error.code = 'INQUIRY_NOTIFY_LIVE_GRAPH_REFUSED';
  throw error;
}

function fixedBandUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== GRAPH_HOST || parsed.username || parsed.password || parsed.hash) {
    return null;
  }
  return parsed;
}

// In-process fixture only. This function must not call or close over a caller fetch.
async function fixedTestBandFetch(url, options = {}) {
  const parsed = fixedBandUrl(url);
  if (!parsed) refuseLiveGraph();
  const method = options.method || 'GET';
  if (method === 'POST' && parsed.pathname === '/v1.0/me/sendMail' && !parsed.search) {
    const posted = JSON.parse(options.body);
    const header = posted?.message?.internetMessageHeaders?.[0];
    if (!header || header.name !== 'x-mi-draft-id' || typeof header.value !== 'string') refuseLiveGraph();
    fixedBandReceipts.set(header.value, {
      id: `fixed-band-${header.value}`,
      isDraft: false,
      subject: posted.message.subject,
      body: posted.message.body,
      toRecipients: posted.message.toRecipients,
      ccRecipients: posted.message.ccRecipients,
      internetMessageHeaders: [header],
      sentDateTime: FIXED_BAND_SENT_AT,
    });
    return new Response(null, { status: 202 });
  }
  if (method === 'GET' && parsed.pathname === '/v1.0/me/mailFolders/sentitems/messages') {
    return new Response(JSON.stringify({ value: [...fixedBandReceipts.values()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  refuseLiveGraph();
}

export function readInquiryNotificationTestBand() {
  return [...fixedBandReceipts.values()].map((receipt) => ({
    graphMessageId: receipt.id,
    subject: receipt.subject,
    body: receipt.body?.content,
    to: receipt.toRecipients,
    cc: receipt.ccRecipients,
    headerName: receipt.internetMessageHeaders?.[0]?.name,
    sentAt: receipt.sentDateTime,
  }));
}

function configReady(config, store) {
  return Boolean(config)
    && config.notifyEnabled === true
    && typeof config.accessToken === 'string'
    && hasMailSendScope(config.accessToken)
    && storeHandle(store);
}

function allowedRecipient(recipient) {
  return typeof recipient === 'string' && recipient.trim().toLowerCase() === INQUIRY_NOTIFY_RECIPIENT;
}

function acceptedApproval(approval) {
  return Boolean(approval)
    && approval.allowSend === true
    && typeof approval.approvedAt === 'string'
    && Number.isFinite(Date.parse(approval.approvedAt))
    && typeof approval.approvedBy === 'string'
    && approval.approvedBy.length <= 160
    && (approval.approvedBy.startsWith('session:') || approval.approvedBy.startsWith('jarvis-receipt:'));
}

function correlationId(inquiryId) {
  const hex = createHash('sha256').update(`mi-inquiry-notify:${inquiryId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fromSendOnce(result) {
  if (result && typeof result.graphMessageId === 'string' && result.graphMessageId && typeof result.sentAt === 'string' && result.sentAt) {
    return envelope({
      sent: true,
      accepted: true,
      confirmed: true,
      graphMessageId: result.graphMessageId,
      sentAt: result.sentAt,
    });
  }
  const graphFailureCode = result?.failureCode || 'GRAPH_ACCEPTANCE_UNKNOWN';
  const accepted = result?.uncertain === true && graphFailureCode.startsWith('GRAPH_RECEIPT_');
  if (result?.uncertain === true || !result || result.uncertain !== false) {
    return failure('INQUIRY_NOTIFY_UNCERTAIN', { accepted, graphFailureCode });
  }
  return failure('INQUIRY_NOTIFY_REJECTED', { graphFailureCode });
}

const PREFLIGHT_CODES = new Set([
  'MAIL_SEND_DISABLED',
  'MAIL_SEND_SCOPE_REQUIRED',
  'HUMAN_APPROVAL_REQUIRED',
  'INVALID_SEND_DRAFT',
  'DRAFT_NEEDS_CLARIFICATION',
  'PARTNER_NAME_BLOCKED',
  'RECIPIENT_NOT_ALLOWED',
  'EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED',
  'MAIL_COMPANY_DOMAIN_INVALID',
  'MAIL_SEND_RECIPIENT_ALLOWLIST_INVALID',
]);

// Test-band draft only. Caller-supplied fetch is never invoked.
// The only transport is the in-process fixed test band. A Set or a new store handle is not a durable send record.
export async function sendInquiryNotification({
  inquiry,
  recipient,
  config,
  fetchImpl,
  store,
  testBand,
  approval,
} = {}) {
  if (!configReady(config, store)) return failure('INQUIRY_NOTIFY_CONFIG_MISSING');
  if (!allowedRecipient(recipient)) return failure('INQUIRY_NOTIFY_RECIPIENT_REJECTED');
  const text = notificationText(inquiry);
  const inquiryId = typeof inquiry?.id === 'string' ? inquiry.id : '';
  if (!text || !INQUIRY_ID_PATTERN.test(inquiryId)) return failure('INQUIRY_NOTIFY_INVALID');
  if (testBand !== INQUIRY_NOTIFY_TEST_BAND) return failure('INQUIRY_NOTIFY_TEST_BAND_REQUIRED', { inquiryId });
  if (fetchImpl !== undefined) return failure('INQUIRY_NOTIFY_LIVE_GRAPH_REFUSED', { inquiryId });
  if (!acceptedApproval(approval)) return failure('INQUIRY_NOTIFY_APPROVAL_REQUIRED', { inquiryId });
  if (harnessLedger.has(inquiryId)) {
    return failure('INQUIRY_ALREADY_NOTIFIED', {
      inquiryId,
      resendBlocked: true,
      priorDisposition: harnessLedger.get(inquiryId).disposition,
    });
  }

  harnessLedger.set(inquiryId, { inquiryId, disposition: 'held', retryable: false });
  const draft = {
    draft_id: correlationId(inquiryId),
    status: 'sending',
    approved_at: approval.approvedAt,
    approved_by: approval.approvedBy,
    to: [INQUIRY_NOTIFY_RECIPIENT],
    cc: [],
    subject: '웹사이트 문의 접수',
    body_text: text,
    attachments: [],
  };
  try {
    const client = new GraphSendClient({
      accessToken: config.accessToken,
      fetchImpl: fixedTestBandFetch,
      recipientAllowlist: [INQUIRY_NOTIFY_RECIPIENT],
      companyDomains: ['blro.co.kr'],
    });
    const result = await client.sendOnce(draft, { allowSend: true });
    const outcome = fromSendOnce(result);
    harnessLedger.set(inquiryId, {
      inquiryId,
      disposition: outcome.confirmed ? 'confirmed' : (outcome.accepted ? 'accepted' : outcome.failureCode),
      retryable: false,
    });
    return { ...outcome, inquiryId, resendBlocked: true };
  } catch (error) {
    if (PREFLIGHT_CODES.has(error?.code)) {
      harnessLedger.delete(inquiryId);
      const code = error.code === 'HUMAN_APPROVAL_REQUIRED' ? 'INQUIRY_NOTIFY_APPROVAL_REQUIRED' : 'INQUIRY_NOTIFY_INVALID';
      return failure(code, { inquiryId });
    }
    harnessLedger.set(inquiryId, { inquiryId, disposition: 'INQUIRY_NOTIFY_UNCERTAIN', retryable: false });
    return failure('INQUIRY_NOTIFY_UNCERTAIN', { inquiryId, resendBlocked: true });
  }
}
