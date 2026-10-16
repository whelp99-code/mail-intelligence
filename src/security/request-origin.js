const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function requestOriginScheme(req) {
  const remote = String(req?.socket?.remoteAddress || '');
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (LOOPBACK_PEERS.has(remote) && forwarded === 'https') return 'https';
  return 'http';
}
