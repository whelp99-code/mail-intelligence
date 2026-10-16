/** Basic login id. Blank keeps the historical username. */
export function configuredAccessUsername(env = process.env) {
  return String(env.MAIL_INTELLIGENCE_ACCESS_USER || '').trim() || 'mailintelligence';
}

/**
 * Username must match the configured id. The password check stays with the
 * caller-supplied constant-time comparison.
 */
export function basicAccessGranted(username, password, accessKey, equals, env = process.env) {
  return username === configuredAccessUsername(env) && equals(password, accessKey);
}

export function accessAuthorizationHeader(accessKey, env = process.env) {
  const username = configuredAccessUsername(env);
  return `Basic ${Buffer.from(`${username}:${accessKey}`, 'utf8').toString('base64')}`;
}
