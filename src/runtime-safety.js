const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function envFlag(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function isLoopbackHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  return LOOPBACK_HOSTS.has(value);
}

export function resolveRuntimeSafety(env = process.env) {
  const host = String(env.MAIL_INTELLIGENCE_HOST || env.HOST || '127.0.0.1').trim();
  const allowRemoteBind = envFlag(env.MAIL_INTELLIGENCE_ALLOW_REMOTE_BIND);
  if (!isLoopbackHost(host) && !allowRemoteBind) {
    throw new Error(
      `Refusing non-loopback bind host "${host}". Set MAIL_INTELLIGENCE_ALLOW_REMOTE_BIND=1 only behind authenticated TLS.`,
    );
  }

  const breakGlass = envFlag(env.MAIL_INTELLIGENCE_UNSAFE_BREAK_GLASS);
  const capabilities = {
    send: breakGlass && envFlag(env.MAIL_INTELLIGENCE_ALLOW_SEND),
    markRead: breakGlass && envFlag(env.MAIL_INTELLIGENCE_ALLOW_MARK_READ),
    dataPlane: breakGlass && envFlag(env.MAIL_INTELLIGENCE_ALLOW_DATA_PLANE),
    cloudAi: envFlag(env.MAIL_INTELLIGENCE_ALLOW_CLOUD_AI),
    remoteAi: envFlag(env.MAIL_INTELLIGENCE_ALLOW_REMOTE_AI),
    fixtures: env.NODE_ENV === 'test' && envFlag(env.MAIL_INTELLIGENCE_ENABLE_FIXTURES)
  };

  return {
    host,
    allowRemoteBind,
    breakGlass,
    capabilities
  };
}

export function requireCapability(safety, capability, message) {
  if (safety?.capabilities?.[capability]) return;
  const error = new Error(message || `Capability "${capability}" is disabled by the v1.2.0 safety policy.`);
  error.statusCode = 403;
  error.code = 'CAPABILITY_DISABLED';
  throw error;
}
