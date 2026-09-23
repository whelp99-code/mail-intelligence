import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { exportExtension } from '../adapters/google-drive-client.js';
import {
  createAttachmentAssetService,
  createUnavailableScanner,
  mimeForAttachmentName,
  normalizeAttachmentFileName,
} from './mail-attachment-assets.js';

const MESSAGES = {
  AUTH_REQUIRED: '인증이 필요합니다.',
  FORBIDDEN: '권한이 없습니다.',
  CSRF_REQUIRED: 'CSRF 토큰이 필요합니다.',
  ORIGIN_REJECTED: '요청 Origin이 허용되지 않습니다.',
  METHOD_NOT_ALLOWED: '허용되지 않은 메서드입니다.',
  INVALID_DRAFT_FIELDS: 'Drive 요청 필드가 올바르지 않습니다.',
  DRIVE_ACCESS_DENIED: '선택한 Google Drive 파일에 접근할 수 없습니다.',
  DRIVE_SOURCE_CHANGED: 'Drive 원본이 변경되어 다시 가져와야 합니다.',
  DRIVE_DOWNLOAD_FAILED: 'Drive 파일을 가져오지 못했습니다.',
  DRIVE_RECHECK_UNAVAILABLE: 'Drive 연결을 사용할 수 없습니다.',
  EXPORT_UNSUPPORTED: '지원하지 않는 Drive 변환 형식입니다.',
  ATTACHMENT_TOO_LARGE: '첨부 파일이 허용 크기를 초과했습니다.',
  REQUEST_CONFLICT: '동일한 요청 ID에 다른 Drive 파일이 있습니다.',
  ASSET_NOT_FOUND: 'Drive 연결 또는 자산을 찾을 수 없습니다.',
  UNSUPPORTED_FILE: '지원하지 않는 파일입니다.',
  IMPORT_CONCURRENCY_LIMIT: '동시에 처리할 수 있는 첨부 요청 수를 초과했습니다.',
  ATTACHMENTS_DISABLED: '첨부 기능이 비활성화되어 있습니다.',
};

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function equal(value, expected) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function errorBody(error, requestId) {
  const code = error?.code || 'INTERNAL_ERROR';
  return {
    error: {
      code,
      message: MESSAGES[code] || 'Drive 요청을 처리할 수 없습니다.',
      request_id: requestId,
    },
  };
}

function exportedName(name, exportMime, googleMime) {
  const ext = exportExtension(googleMime, exportMime);
  if (!ext) fail(422, 'EXPORT_UNSUPPORTED');
  const base = String(name || 'document').replace(/\.[^.]+$/, '');
  return normalizeAttachmentFileName(`${base}${ext}`);
}

export function createMailDriveApi({
  getStore,
  getMailbox,
  getSession,
  readBody,
  serviceToken = '',
  attachmentsEnabled = false,
  driveEnabled = false,
  getAttachmentKey,
  scanner = createUnavailableScanner(),
  connections,
  client,
  now,
} = {}) {
  return async (req, url) => {
    const requestId = String(req.headers['x-request-id'] || randomUUID());
    try {
      const match = /^\/api\/mail\/drive\/(status|connect|picker-token|import|disconnect|selection)$/.exec(url.pathname);
      if (!match) fail(404, 'ASSET_NOT_FOUND');
      const action = match[1];
      const authorization = String(req.headers.authorization || '');
      const bot = authorization.startsWith('Bearer ');
      let session;
      if (bot) {
        if (serviceToken.length < 32 || !equal(authorization.slice(7), serviceToken)) fail(401, 'AUTH_REQUIRED');
        if (action !== 'import') fail(403, 'FORBIDDEN');
        if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
      } else {
        session = getSession(req);
        if (!session) fail(401, 'AUTH_REQUIRED');
        if (req.method === 'POST') {
          if (!equal(req.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REQUIRED');
          if (req.headers.origin !== url.origin) fail(403, 'ORIGIN_REJECTED');
        }
      }
      if (!driveEnabled) fail(503, 'DRIVE_RECHECK_UNAVAILABLE');
      const store = getStore();
      const mailbox = getMailbox();
      const source = bot ? 'grok-bot' : 'ui';
      const assets = createAttachmentAssetService({
        db: store.db,
        getKey: getAttachmentKey,
        scanner,
        attachmentsEnabled,
        now,
      });

      if (action === 'status' && req.method === 'GET') {
        return {
          status: 200,
          body: {
            drive_enabled: true,
            connections: connections.listActive(mailbox.id),
          },
        };
      }
      if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED');
      const body = await readBody(req);

      if (action === 'connect') {
        const started = connections.startConnect({
          mailboxId: mailbox.id,
          sessionToken: session.token,
          returnPath: body.return_path || '/',
        });
        return { status: 200, body: { authorization_url: started.authorization_url } };
      }
      if (action === 'picker-token') {
        if (!body.connection_id) fail(400, 'INVALID_DRAFT_FIELDS');
        const token = await connections.accessToken(mailbox.id, body.connection_id);
        return {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
          body: {
            access_token: token.access_token,
            expires_in: token.expires_in,
          },
        };
      }
      if (action === 'selection') {
        return {
          status: 200,
          body: await connections.recordSelection({
            mailboxId: mailbox.id,
            connectionId: body.connection_id,
            fileId: body.file_id,
            resourceKey: body.resource_key || '',
          }),
        };
      }
      if (action === 'disconnect') {
        return { status: 200, body: connections.disconnect({ mailboxId: mailbox.id, connectionId: body.connection_id }) };
      }
      if (action === 'import') {
        const keys = new Set(['request_id', 'connection_id', 'file_id', 'resource_key', 'export_mime']);
        if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !keys.has(key))) fail(400, 'INVALID_DRAFT_FIELDS');
        const connectionId = String(body.connection_id || '');
        const fileId = String(body.file_id || '');
        connections.requireGrant({ mailboxId: mailbox.id, connectionId, fileId });
        const existing = assets.peekByRequest(mailbox.id, source, body.request_id);
        if (existing) {
          if (
            existing.drive_connection_id !== connectionId
            || existing.drive_file_id !== fileId
            || (existing.export_mime || null) !== (body.export_mime || null)
          ) {
            fail(409, 'REQUEST_CONFLICT');
          }
          return {
            status: 200,
            body: {
              id: existing.id,
              name: existing.name,
              mime: existing.mime,
              size: existing.size,
              sha256: existing.sha256,
              state: existing.state,
              replay: true,
            },
          };
        }
        const token = await connections.accessToken(mailbox.id, connectionId);
        const grant = connections.requireGrant({ mailboxId: mailbox.id, connectionId, fileId });
        const resourceKey = (body.resource_key || await connections.openResourceKey(grant) || '') || undefined;
        const before = await client.getMetadata({
          accessToken: token.access_token,
          fileId,
          resourceKey,
        });
        if (before.trashed || before.capabilities?.canDownload !== true) fail(403, 'DRIVE_ACCESS_DENIED');
        const googleMime = String(before.mimeType || '');
        let bytes;
        let displayName;
        let exportMime = body.export_mime || null;
        if (googleMime.startsWith('application/vnd.google-apps.')) {
          exportMime = body.export_mime || 'application/pdf';
          if (!exportExtension(googleMime, exportMime)) fail(422, 'EXPORT_UNSUPPORTED');
          bytes = await client.exportFile({
            accessToken: token.access_token,
            fileId,
            resourceKey,
            exportMime,
          });
          displayName = exportedName(before.name, exportMime, googleMime);
        } else {
          exportMime = null;
          displayName = normalizeAttachmentFileName(before.name);
          mimeForAttachmentName(displayName);
          bytes = await client.download({ accessToken: token.access_token, fileId, resourceKey });
        }
        const after = await client.getMetadata({
          accessToken: token.access_token,
          fileId,
          resourceKey,
        });
        if (String(after.version) !== String(before.version) || after.trashed) fail(409, 'DRIVE_SOURCE_CHANGED');
        const result = await assets.upload({
          mailboxId: mailbox.id,
          source,
          requestId: body.request_id,
          displayName,
          declaredMime: exportMime || after.mimeType,
          origin: 'drive',
          contentLength: bytes.length,
          body: Readable.from(bytes),
          drive: {
            connectionId,
            fileId,
            version: String(after.version),
            modifiedTime: after.modifiedTime || null,
            exportMime,
            resourceKey: null,
          },
        });
        const asset = result.asset;
        return {
          status: result.replay ? 200 : 201,
          body: {
            id: asset.id,
            name: asset.name,
            mime: asset.mime,
            size: asset.size,
            sha256: asset.sha256,
            state: asset.state,
            replay: result.replay,
          },
        };
      }
      fail(405, 'METHOD_NOT_ALLOWED');
    } catch (error) {
      error.body = errorBody(error, requestId);
      throw error;
    }
  };
}

export async function completeGoogleDriveCallback({
  connections,
  session,
  mailboxId,
  code,
  state,
  fetchImpl,
}) {
  if (!session?.token) fail(401, 'AUTH_REQUIRED');
  return connections.finishCallback({
    code,
    state,
    sessionToken: session.token,
    mailboxId,
    fetchImpl,
  });
}
