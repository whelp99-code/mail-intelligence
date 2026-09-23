import { readBoundedOctetStream } from '../application/mail-attachment-assets.js';

export const GOOGLE_API_ORIGIN = 'https://www.googleapis.com';
export const GOOGLE_OAUTH_ORIGIN = 'https://oauth2.googleapis.com';
export const GOOGLE_ACCOUNTS_ORIGIN = 'https://accounts.google.com';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_OPENID_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE];

export const GOOGLE_EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': Object.freeze({
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  }),
  'application/vnd.google-apps.spreadsheet': Object.freeze({
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  }),
  'application/vnd.google-apps.presentation': Object.freeze({
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  }),
});

const FILE_FIELDS = 'id,name,mimeType,size,version,modifiedTime,trashed,capabilities(canDownload)';

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

export function assertGoogleApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(502, 'DRIVE_DOWNLOAD_FAILED');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) fail(502, 'DRIVE_DOWNLOAD_FAILED');
  if (!['www.googleapis.com', 'oauth2.googleapis.com'].includes(parsed.hostname)) fail(502, 'DRIVE_DOWNLOAD_FAILED');
  if (parsed.pathname.includes('/permissions') || parsed.pathname.includes('..')) fail(403, 'DRIVE_ACCESS_DENIED');
  return parsed;
}

export function exportExtension(googleMime, exportMime) {
  return GOOGLE_EXPORTS[googleMime]?.[exportMime] || null;
}

export function createGoogleDriveClient({
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxBytes = 2_097_152,
} = {}) {
  async function request(url, { method = 'GET', headers = {}, body, accessToken, timeout = timeoutMs } = {}) {
    const parsed = assertGoogleApiUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(parsed.toString(), {
        method,
        headers: {
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...headers,
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') fail(502, 'DRIVE_DOWNLOAD_FAILED');
      fail(502, 'DRIVE_DOWNLOAD_FAILED');
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) fail(502, 'DRIVE_DOWNLOAD_FAILED');
    return response;
  }

  function resourceHeaders(fileId, resourceKey) {
    if (!resourceKey) return {};
    return { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` };
  }

  return {
    async exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      });
      const response = await request(`${GOOGLE_OAUTH_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) fail(403, 'DRIVE_ACCESS_DENIED');
      return response.json();
    },

    async refreshAccessToken({ clientId, clientSecret, refreshToken }) {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const response = await request(`${GOOGLE_OAUTH_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) fail(403, 'DRIVE_ACCESS_DENIED');
      return response.json();
    },

    async getMetadata({ accessToken, fileId, resourceKey, timeout = 10_000 }) {
      const url = new URL(`${GOOGLE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('fields', FILE_FIELDS);
      url.searchParams.set('supportsAllDrives', 'true');
      const response = await request(url, {
        accessToken,
        headers: resourceHeaders(fileId, resourceKey),
        timeout,
      });
      if (response.status === 404 || response.status === 403) fail(403, 'DRIVE_ACCESS_DENIED');
      if (!response.ok) fail(502, 'DRIVE_DOWNLOAD_FAILED');
      return response.json();
    },

    async download({ accessToken, fileId, resourceKey }) {
      const url = new URL(`${GOOGLE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('alt', 'media');
      url.searchParams.set('supportsAllDrives', 'true');
      const response = await request(url, {
        accessToken,
        headers: resourceHeaders(fileId, resourceKey),
      });
      if (response.status === 404 || response.status === 403) fail(403, 'DRIVE_ACCESS_DENIED');
      if (!response.ok) fail(502, 'DRIVE_DOWNLOAD_FAILED');
      try {
        return await readBoundedOctetStream(response.body, maxBytes);
      } catch (error) {
        if (error?.code === 'ATTACHMENT_TOO_LARGE') throw error;
        fail(502, 'DRIVE_DOWNLOAD_FAILED');
      }
    },

    async exportFile({ accessToken, fileId, resourceKey, exportMime }) {
      const url = new URL(`${GOOGLE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}/export`);
      url.searchParams.set('mimeType', exportMime);
      const response = await request(url, {
        accessToken,
        headers: resourceHeaders(fileId, resourceKey),
      });
      if (response.status === 404 || response.status === 403) fail(403, 'DRIVE_ACCESS_DENIED');
      if (!response.ok) fail(502, 'DRIVE_DOWNLOAD_FAILED');
      try {
        return await readBoundedOctetStream(response.body, maxBytes);
      } catch (error) {
        if (error?.code === 'ATTACHMENT_TOO_LARGE') throw error;
        fail(502, 'DRIVE_DOWNLOAD_FAILED');
      }
    },
  };
}
