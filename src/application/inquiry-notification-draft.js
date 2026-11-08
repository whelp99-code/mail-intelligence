import { GraphSendClient, hasMailSendScope } from '../adapters/microsoft-graph-send.js';
import { graphTextBody } from '../domain/reply-draft-guardrails.js';

export const INQUIRY_NOTIFY_RECIPIENT = 'jm.park@blro.co.kr';
const GRAPH_SEND_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';
const INQUIRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const RECEIVED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function failure(code) {
  return { sent: false, failureCode: code };
}

function singleLine(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || CONTROL_CHARS.test(text)) return null;
  return text;
}

function inquiryBody(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 4000 || text.includes('\0')) return null;
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

function configReady(config, fetchImpl, sentIds) {
  return Boolean(config)
    && config.notifyEnabled === true
    && typeof config.accessToken === 'string'
    && hasMailSendScope(config.accessToken)
    && typeof fetchImpl === 'function'
    && fetchImpl !== globalThis.fetch
    && sentIds instanceof Set;
}

function allowedRecipient(recipient) {
  return typeof recipient === 'string' && recipient.trim().toLowerCase() === INQUIRY_NOTIFY_RECIPIENT;
}

// Draft-only website inquiry notice. This does not approve or send reply drafts,
// and it refuses the process fetch so a missing explicit double cannot reach Graph.
export async function sendInquiryNotification({
  inquiry,
  recipient,
  config,
  fetchImpl,
  sentIds,
  clientFactory = (options) => new GraphSendClient(options),
} = {}) {
  if (!configReady(config, fetchImpl, sentIds)) return failure('INQUIRY_NOTIFY_CONFIG_MISSING');
  if (!allowedRecipient(recipient)) return failure('INQUIRY_NOTIFY_RECIPIENT_REJECTED');
  const text = notificationText(inquiry);
  const inquiryId = typeof inquiry?.id === 'string' ? inquiry.id : '';
  if (!text || !INQUIRY_ID_PATTERN.test(inquiryId)) return failure('INQUIRY_NOTIFY_INVALID');
  if (sentIds.has(inquiryId)) return failure('INQUIRY_ALREADY_NOTIFIED');
  sentIds.add(inquiryId);

  const message = {
    subject: '웹사이트 문의 접수',
    body: graphTextBody(text),
    toRecipients: [{ emailAddress: { address: INQUIRY_NOTIFY_RECIPIENT } }],
    ccRecipients: [],
    internetMessageHeaders: [{ name: 'x-mi-inquiry-id', value: inquiryId }],
  };
  try {
    const client = clientFactory({
      accessToken: config.accessToken,
      fetchImpl,
      recipientAllowlist: [INQUIRY_NOTIFY_RECIPIENT],
    });
    const response = await client.request(GRAPH_SEND_URL, {
      method: 'POST',
      body: { message, saveToSentItems: true },
    });
    if (response?.status === 202) return { sent: true, inquiryId };
    const uncertain = !Number.isInteger(response?.status) || response.status < 400 || response.status >= 500 || response.status === 408;
    return failure(uncertain ? 'INQUIRY_NOTIFY_UNCERTAIN' : 'INQUIRY_NOTIFY_REJECTED');
  } catch {
    return failure('INQUIRY_NOTIFY_UNCERTAIN');
  }
}
