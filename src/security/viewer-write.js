export function rejectViewerWrite(session, req) {
  if (session?.role !== 'viewer') return;
  const method = String(req?.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const path = String(req?.url || '').split('?')[0];
  if (method === 'DELETE' && path === '/api/session') return;
  throw Object.assign(new Error('Viewer sessions cannot change mail state.'), {
    statusCode: 403,
    code: 'VIEWER_WRITE_FORBIDDEN',
  });
}
