import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createAttachmentAssetService,
  createUnavailableScanner,
} from './mail-attachment-assets.js';

const MESSAGES = {
  ATTACHMENTS_DISABLED: '첨부 기능이 비활성화되어 있습니다.',
  SCANNER_UNAVAILABLE: '첨부 검사기를 사용할 수 없습니다.',
  ATTACHMENT_TOO_LARGE: '첨부 파일이 허용 크기를 초과했습니다.',
  ATTACHMENT_QUOTA_EXCEEDED: '첨부 저장 용량을 초과했습니다.',
  REQUEST_CONFLICT: '동일한 요청 ID에 다른 파일이 있습니다.',
  ASSET_NOT_FOUND: '첨부 자산을 찾을 수 없습니다.',
  UNSUPPORTED_FILE: '지원하지 않는 파일입니다.',
  AUTH_REQUIRED: '인증이 필요합니다.',
  FORBIDDEN: '권한이 없습니다.',
  IMPORT_CONCURRENCY_LIMIT: '동시에 처리할 수 있는 첨부 요청 수를 초과했습니다.',
  ASSET_CHANGED: '첨부 파일이 변경되어 다시 업로드해야 합니다.',
  DRAFT_IMMUTABLE: '저장된 초안의 파일은 바꿀 수 없습니다.',
  INVALID_REQUEST_ID: '업로드 요청 ID가 올바르지 않습니다.',
  CSRF_REQUIRED: 'CSRF 토큰이 필요합니다.',
  ORIGIN_REJECTED: '요청 Origin이 허용되지 않습니다.',
  METHOD_NOT_ALLOWED: '허용되지 않은 메서드입니다.',
  SESSION_REQUIRED: '로그인이 필요합니다.',
  DRAFT_TOKEN_REQUIRED: '봇 토큰이 필요합니다.',
};

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function equal(value, expected) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function decodeFileName(value) {
  try {
    const decoded = Buffer.from(String(value || ''), 'base64url').toString('utf8');
    if (!decoded) fail(422, 'UNSUPPORTED_FILE');
    return decoded;
  } catch {
    fail(422, 'UNSUPPORTED_FILE');
  }
}

function errorBody(error, requestId) {
  const code = error?.code || 'INTERNAL_ERROR';
  return {
    error: {
      code,
      message: MESSAGES[code] || '첨부 요청을 처리할 수 없습니다.',
      request_id: requestId,
    },
  };
}

export function encodeUploadFileName(name) {
  return Buffer.from(String(name), 'utf8').toString('base64url');
}

export function createMailAttachmentApi({
  getStore,
  getMailbox,
  getSession,
  serviceToken = '',
  attachmentsEnabled = false,
  getAttachmentKey,
  scanner = createUnavailableScanner(),
  now,
  limits,
} = {}) {
  return async (req, url) => {
    const match = /^\/api\/mail\/attachment-assets(?:\/([0-9a-f-]{36})(?:\/(content|discard))?)?$/.exec(url.pathname);
    if (!match) fail(404, 'ASSET_NOT_FOUND');
    const [, id, action] = match;
    const requestId = String(req.headers['x-upload-request-id'] || req.headers['x-request-id'] || randomUUID());
    try {
      const authorization = String(req.headers.authorization || '');
      const bot = authorization.startsWith('Bearer ');
      let session;
      if (bot) {
        if (serviceToken.length < 32 || !equal(authorization.slice(7), serviceToken)) fail(401, 'AUTH_REQUIRED');
        if (action === 'content') fail(403, 'FORBIDDEN');
        if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED');
      } else {
        session = getSession(req);
        if (!session) fail(401, 'AUTH_REQUIRED');
        if (req.method === 'POST') {
          if (!equal(req.headers['x-csrf-token'], session.csrfToken)) fail(403, 'CSRF_REQUIRED');
          if (req.headers.origin !== url.origin) fail(403, 'ORIGIN_REJECTED');
        }
      }

      const store = getStore();
      const mailbox = getMailbox();
      const source = bot ? 'grok-bot' : 'ui';
      const service = createAttachmentAssetService({
        db: store.db,
        getKey: getAttachmentKey,
        scanner,
        attachmentsEnabled,
        now,
        limits,
      });

      if (!id && req.method === 'POST') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.startsWith('application/octet-stream')) fail(422, 'UNSUPPORTED_FILE');
        const uploadRequestId = String(req.headers['x-upload-request-id'] || '');
        const result = await service.upload({
          mailboxId: mailbox.id,
          source,
          requestId: uploadRequestId,
          displayName: decodeFileName(req.headers['x-file-name']),
          declaredMime: req.headers['x-file-type'],
          origin: 'local',
          contentLength: req.headers['content-length'],
          body: req.body !== undefined ? req.body : req,
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
          },
        };
      }

      if (!id) fail(405, 'METHOD_NOT_ALLOWED');
      if (action === 'content' && req.method === 'GET') {
        const content = await service.getContent(mailbox.id, id, { actor: 'human' });
        const encoded = encodeURIComponent(content.name);
        return {
          status: 200,
          raw: true,
          headers: {
            'Content-Type': content.mime,
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encoded}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
          body: content.bytes,
        };
      }
      if (action === 'discard' && req.method === 'POST') {
        return { status: 200, body: service.discard(mailbox.id, id, { source }) };
      }
      fail(405, 'METHOD_NOT_ALLOWED');
    } catch (error) {
      error.body = errorBody(error, requestId);
      throw error;
    }
  };
}
