import { GraphMailError } from './microsoft-graph-mail.js';

const GRAPH_SEND_TIMEOUT_MS = 30_000;

function mailboxPath(value = '') {
  const path = String(value || '/me').trim() || '/me';
  if (path === '/me') return path;
  if (/^\/users\/[^/?#]+$/.test(path)) return path;
  throw new Error('mailboxPath must be /me or /users/{encoded-user}.');
}

function recipientList(values = []) {
  return (Array.isArray(values) ? values : [values])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

function fileAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((item) => item?.contentBytes && item?.name)
    .map((item) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: String(item.name),
      contentType: String(item.contentType || 'application/octet-stream'),
      contentBytes: String(item.contentBytes),
    }));
}

export function buildGraphSendPayload(draft = {}) {
  const toRecipients = recipientList(draft.to);
  if (!toRecipients.length) {
    throw new GraphMailError('A send draft must include at least one recipient.', {
      code: 'DRAFT_RECIPIENT_REQUIRED',
      statusCode: 400,
    });
  }
  const message = {
    subject: String(draft.subject || ''),
    body: {
      contentType: String(draft.contentType || 'text').toLowerCase() === 'html' ? 'HTML' : 'Text',
      content: String(draft.body || ''),
    },
    toRecipients,
  };
  const ccRecipients = recipientList(draft.cc);
  const bccRecipients = recipientList(draft.bcc);
  if (ccRecipients.length) message.ccRecipients = ccRecipients;
  if (bccRecipients.length) message.bccRecipients = bccRecipients;
  const attachments = fileAttachments(draft.resolvedAttachments);
  if (attachments.length) message.attachments = attachments;
  return {
    message,
    saveToSentItems: draft.saveToSentItems !== false,
  };
}

export async function submitApprovedGraphMail({
  fetchImpl = globalThis.fetch,
  accessToken,
  graphBaseUrl = 'https://graph.microsoft.com/v1.0',
  mailboxUser = '',
  draft,
  timeoutMs = GRAPH_SEND_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required.');
  if (!accessToken) {
    throw new GraphMailError('Microsoft Graph access token is required for approved send.', {
      code: 'GRAPH_TOKEN_REQUIRED',
      statusCode: 503,
    });
  }
  const payload = buildGraphSendPayload(draft);
  const path = mailboxUser ? `/users/${encodeURIComponent(mailboxUser)}` : mailboxPath(draft.mailboxPath);
  const target = `${String(graphBaseUrl).replace(/\/$/, '')}${path}/sendMail`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || GRAPH_SEND_TIMEOUT_MS, 1_000), 120_000));
  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const requestId = String(response.headers.get('request-id') || response.headers.get('client-request-id') || '');
    if (response.status !== 202 && !response.ok) {
      const statusCode = Number(response.status || 0);
      throw new GraphMailError(`Approved Graph mail submission failed with HTTP ${statusCode}.`, {
        code: statusCode >= 500 || statusCode === 429 ? 'GRAPH_TRANSIENT_ERROR' : 'GRAPH_SEND_FAILED',
        statusCode,
        retryable: statusCode >= 500 || statusCode === 429,
      });
    }
    return {
      adapter: 'microsoft-graph',
      httpStatus: Number(response.status || 202),
      requestId,
      submittedAt: new Date().toISOString(),
      saveToSentItems: payload.saveToSentItems,
      mailboxPath: path,
    };
  } catch (error) {
    if (error instanceof GraphMailError) throw error;
    if (error?.name === 'AbortError') {
      throw new GraphMailError('Approved Graph mail submission timed out.', {
        code: 'GRAPH_TIMEOUT',
        retryable: true,
      });
    }
    throw new GraphMailError('Approved Graph mail submission failed.', {
      code: 'GRAPH_NETWORK_ERROR',
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}
