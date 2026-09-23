import { createNotionWorkSystem } from '../adapters/notion-work-system.js';
import { WorkLinkService } from './work-links.js';

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message || code), { statusCode, code });
}

export function createWorkLinksApi({
  getStore,
  getMailboxUser,
  getSession,
  snapshotPath = '',
}) {
  return async function workLinksApi(req, url) {
    const session = getSession(req);
    if (!session) fail(401, 'SESSION_REQUIRED', 'Session required.');
    if (req.method === 'POST') {
      if (String(req.headers['x-csrf-token'] || '') !== String(session.csrfToken || '')) {
        fail(403, 'CSRF_REQUIRED', 'CSRF token required.');
      }
      if (req.headers.origin && url.origin && req.headers.origin !== url.origin) {
        fail(403, 'ORIGIN_REJECTED', 'Origin rejected.');
      }
    }

    const mailboxUser = getMailboxUser();
    const store = getStore();
    const service = new WorkLinkService({
      store,
      workSystem: createNotionWorkSystem({ snapshotPath }),
    });

    if (url.pathname === '/api/work-links/stats') {
      if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return { status: 200, body: service.stats(mailboxUser) };
    }

    if (url.pathname === '/api/work-links/refresh') {
      if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      if (!snapshotPath) fail(503, 'SNAPSHOT_REQUIRED', 'MAIL_INTELLIGENCE_NOTION_SNAPSHOT is not set.');
      const result = await service.refresh(mailboxUser, { snapshotPath });
      return { status: 200, body: result };
    }

    if (url.pathname === '/api/work-links') {
      if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      const messageId = String(url.searchParams.get('messageId') || '').trim();
      const payload = service.list(mailboxUser);
      if (!messageId) return { status: 200, body: payload };
      return {
        status: 200,
        body: {
          links: payload.links.filter((item) => item.graphId === messageId && item.status === 'candidate'),
          stats: payload.stats,
        },
      };
    }

    fail(404, 'WORK_LINKS_NOT_FOUND', 'Not found.');
  };
}
