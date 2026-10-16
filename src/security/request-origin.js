const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function requestOriginScheme(req) {
  const remote = String(req?.socket?.remoteAddress || '');
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (LOOPBACK_PEERS.has(remote) && forwarded === 'https') return 'https';
  return 'http';
}

export function expectedRequestOrigin(req, url) {
  const scheme = requestOriginScheme(req);
  const headerHost = String(req?.headers?.host || '').trim();
  const host = headerHost || String(url?.host || '').trim();
  if (!host) return '';
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return '';
  }
}

export function browserOriginAllowed(req, url) {
  const expected = expectedRequestOrigin(req, url);
  if (!expected) return false;
  try {
    return new URL(String(req?.headers?.origin || '')).origin === expected;
  } catch {
    return false;
  }
}
