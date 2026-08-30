const DEFAULT_SELECT = [
  'id',
  'changeKey',
  'conversationId',
  'internetMessageId',
  'subject',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'createdDateTime',
  'lastModifiedDateTime',
  'importance',
  'inferenceClassification',
  'flag',
  'categories',
  'isRead',
  'isDraft',
  'hasAttachments',
  'bodyPreview',
  'body',
  'webLink',
  'parentFolderId',
].join(',');

const ATTACHMENT_SELECT = [
  'id',
  'name',
  'contentType',
  'size',
  'isInline',
  'contentId',
  'lastModifiedDateTime',
].join(',');

export class GraphMailError extends Error {
  constructor(message, { code = 'GRAPH_REQUEST_FAILED', statusCode = 0, retryable = false } = {}) {
    super(message);
    this.name = 'GraphMailError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function safeMailboxPath(value) {
  const path = String(value || '/me');
  if (path === '/me') return path;
  if (/^\/users\/[^/?#]+$/.test(path)) return path;
  throw new Error('mailboxPath must be /me or /users/{encoded-user}.');
}

function hasControlCharacters(value) {
  return [...String(value ?? '')].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function safeFolderId(value) {
  const folderId = String(value || '').trim();
  if (!folderId || folderId.length > 2000 || hasControlCharacters(folderId)) {
    throw new Error('folderId must be a non-empty Graph folder id or well-known name.');
  }
  return folderId;
}

export class GraphMailClient {
  constructor({
    fetchImpl = globalThis.fetch,
    accessToken,
    graphBaseUrl = 'https://graph.microsoft.com/v1.0',
    timeoutMs = 30_000,
    pageSize = 50,
    maxPages = 1_000,
    allowedContinuationOrigins,
  }) {
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required.');
    if (!accessToken) throw new Error('Microsoft Graph access token is required.');
    this.fetchImpl = fetchImpl;
    this.accessToken = accessToken;
    this.graphBaseUrl = String(graphBaseUrl).replace(/\/$/, '');
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 30_000, 1_000), 120_000);
    this.pageSize = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    this.maxPages = Math.min(Math.max(Number(maxPages) || 1_000, 1), 10_000);
    const base = new URL(this.graphBaseUrl);
    this.allowedContinuationOrigins = new Set(allowedContinuationOrigins || [base.origin]);
  }

  buildInitialDeltaUrl({ mailboxPath = '/me', folderId = 'inbox' } = {}) {
    const path = safeMailboxPath(mailboxPath);
    const folder = safeFolderId(folderId);
    const url = new URL(`${this.graphBaseUrl}${path}/mailFolders/${encodeURIComponent(folder)}/messages/delta`);
    url.searchParams.set('$select', DEFAULT_SELECT);
    url.searchParams.set('$top', String(this.pageSize));
    return url.toString();
  }

  validateContinuationUrl(value) {
    let url;
    try {
      url = new URL(String(value || ''));
    } catch {
      throw new GraphMailError('Microsoft Graph returned an invalid continuation URL.', {
        code: 'GRAPH_CONTINUATION_INVALID',
      });
    }
    const loopbackHttp = url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopbackHttp) {
      throw new GraphMailError('Microsoft Graph continuation URL must use HTTPS.', {
        code: 'GRAPH_CONTINUATION_REJECTED',
      });
    }
    if (!this.allowedContinuationOrigins.has(url.origin)) {
      throw new GraphMailError('Microsoft Graph continuation URL origin is not allowed.', {
        code: 'GRAPH_CONTINUATION_REJECTED',
      });
    }
    return url.toString();
  }

  async requestJson(url) {
    const target = this.validateContinuationUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Prefer: 'outlook.body-content-type="text"',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const statusCode = Number(response.status || 0);
        if (statusCode === 410) {
          throw new GraphMailError('Microsoft Graph delta cursor expired and requires a fresh synchronization.', {
            code: 'DELTA_CURSOR_EXPIRED',
            statusCode,
          });
        }
        const retryable = statusCode === 429 || statusCode >= 500;
        throw new GraphMailError(`Microsoft Graph request failed with HTTP ${statusCode}.`, {
          code: retryable ? 'GRAPH_TRANSIENT_ERROR' : 'GRAPH_REQUEST_FAILED',
          statusCode,
          retryable,
        });
      }
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.value)) {
        throw new GraphMailError('Microsoft Graph response did not contain a value array.', {
          code: 'GRAPH_RESPONSE_INVALID',
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof GraphMailError) throw error;
      if (error?.name === 'AbortError') {
        throw new GraphMailError(`Microsoft Graph request timed out after ${this.timeoutMs}ms.`, {
          code: 'GRAPH_TIMEOUT',
          retryable: true,
        });
      }
      throw new GraphMailError('Microsoft Graph network request failed.', {
        code: 'GRAPH_NETWORK_ERROR',
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async *iterateDelta({ mailboxPath = '/me', folderId = 'inbox', startUrl = '' } = {}) {
    let url = startUrl
      ? this.validateContinuationUrl(startUrl)
      : this.buildInitialDeltaUrl({ mailboxPath, folderId });
    for (let pageIndex = 0; pageIndex < this.maxPages; pageIndex += 1) {
      const requestUrl = url;
      const payload = await this.requestJson(requestUrl);
      const nextLink = payload['@odata.nextLink']
        ? this.validateContinuationUrl(payload['@odata.nextLink'])
        : '';
      const deltaLink = payload['@odata.deltaLink']
        ? this.validateContinuationUrl(payload['@odata.deltaLink'])
        : '';
      if (!nextLink && !deltaLink) {
        throw new GraphMailError('Microsoft Graph delta page contained neither nextLink nor deltaLink.', {
          code: 'GRAPH_CURSOR_MISSING',
        });
      }
      yield {
        pageIndex,
        requestUrl,
        items: payload.value,
        nextLink,
        deltaLink,
      };
      if (deltaLink) return;
      url = nextLink;
    }
    throw new GraphMailError(`Microsoft Graph delta synchronization exceeded ${this.maxPages} pages.`, {
      code: 'GRAPH_MAX_PAGES_EXCEEDED',
    });
  }

  async listMailFolders({ mailboxPath = '/me', includeHidden = true, maxFolders = 1_000 } = {}) {
    const path = safeMailboxPath(mailboxPath);
    const boundedMax = Math.min(Math.max(Number(maxFolders) || 1_000, 1), 5_000);
    const select = 'id,displayName,parentFolderId,childFolderCount,totalItemCount,unreadItemCount,isHidden';
    const rootUrl = new URL(`${this.graphBaseUrl}${path}/mailFolders`);
    rootUrl.searchParams.set('includeHiddenFolders', includeHidden ? 'true' : 'false');
    rootUrl.searchParams.set('$select', select);
    rootUrl.searchParams.set('$top', '100');
    const queue = [{ url: rootUrl.toString(), parentId: '' }];
    const folders = [];
    const seen = new Set();

    while (queue.length) {
      let { url, parentId } = queue.shift();
      while (url) {
        const payload = await this.requestJson(url);
        for (const raw of payload.value) {
          const id = String(raw?.id || '').trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const folder = {
            id,
            displayName: String(raw.displayName || '').trim(),
            parentFolderId: String(raw.parentFolderId || parentId || '').trim(),
            childFolderCount: Math.max(Number(raw.childFolderCount || 0), 0),
            totalItemCount: Math.max(Number(raw.totalItemCount || 0), 0),
            unreadItemCount: Math.max(Number(raw.unreadItemCount || 0), 0),
            isHidden: Boolean(raw.isHidden),
          };
          if (includeHidden || !folder.isHidden) folders.push(folder);
          if (folder.childFolderCount > 0) {
            const childUrl = new URL(`${this.graphBaseUrl}${path}/mailFolders/${encodeURIComponent(id)}/childFolders`);
            childUrl.searchParams.set('includeHiddenFolders', includeHidden ? 'true' : 'false');
            childUrl.searchParams.set('$select', select);
            childUrl.searchParams.set('$top', '100');
            queue.push({ url: childUrl.toString(), parentId: id });
          }
          if (seen.size > boundedMax) {
            throw new GraphMailError(`Mailbox folder discovery exceeded ${boundedMax} folders.`, {
              code: 'GRAPH_MAX_FOLDERS_EXCEEDED',
            });
          }
        }
        url = payload['@odata.nextLink']
          ? this.validateContinuationUrl(payload['@odata.nextLink'])
          : '';
      }
    }
    return folders;
  }

  async fetchAttachmentMetadata({ mailboxPath = '/me', messageId }) {
    const path = safeMailboxPath(mailboxPath);
    const id = String(messageId || '').trim();
    if (!id) throw new Error('messageId is required.');
    const url = new URL(`${this.graphBaseUrl}${path}/messages/${encodeURIComponent(id)}/attachments`);
    url.searchParams.set('$select', ATTACHMENT_SELECT);
    url.searchParams.set('$top', '100');
    const attachments = [];
    let target = url.toString();
    for (let page = 0; page < 20; page += 1) {
      const payload = await this.requestJson(target);
      attachments.push(...payload.value);
      if (!payload['@odata.nextLink']) return attachments;
      target = this.validateContinuationUrl(payload['@odata.nextLink']);
    }
    throw new GraphMailError('Attachment metadata pagination exceeded 20 pages.', {
      code: 'GRAPH_MAX_PAGES_EXCEEDED',
    });
  }
}

export const graphMailInternals = {
  ATTACHMENT_SELECT,
  DEFAULT_SELECT,
  safeFolderId,
  safeMailboxPath,
};
