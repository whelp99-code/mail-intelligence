/**
 * Destructive Outlook API gate — requires approval header when MAIL_REQUIRE_APPROVAL=true.
 * See docs/SECURITY-ROTATION-CHECKLIST.md
 */

const DESTRUCTIVE_PATHS = new Set([
  '/api/outlook/send',
  '/api/outlook/read',
  '/api/outlook/config'
]);

export function isDestructiveApi(pathname, method) {
  if (/^\/api\/outlook\/send-requests\/[^/]+\/complete$/.test(pathname) && method === 'POST') return true;
  if (pathname === '/api/outlook/send' && method === 'POST') return true;
  if (pathname === '/api/outlook/read' && method === 'POST') return true;
  if (pathname === '/api/outlook/config' && method === 'DELETE') return true;
  return DESTRUCTIVE_PATHS.has(pathname) && method !== 'GET';
}

export function checkDestructiveApproval(req) {
  const approvalId = String(req.headers['x-aios-approval-id'] || '').trim();
  const internalKey = String(process.env.MAIL_INTERNAL_API_KEY || '').trim();
  const providedKey = String(req.headers['x-mail-internal-key'] || '').trim();

  if (approvalId && internalKey && providedKey === internalKey) {
    return { allowed: true, approvalId };
  }

  if (process.env.MAIL_REQUIRE_APPROVAL !== 'true') {
    return { allowed: true };
  }

  return {
    allowed: false,
    statusCode: 403,
    body: {
      success: false,
      approvalStatus: 'pending',
      error: '승인이 필요합니다. AIOSv2 approval gate와 X-Mail-Internal-Key 검증을 통해 호출하세요.',
      destructive: true
    }
  };
}
