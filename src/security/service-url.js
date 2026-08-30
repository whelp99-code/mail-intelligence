export function isLoopbackHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  return value === 'localhost'
    || value === '127.0.0.1'
    || value === '::1'
    || value.endsWith('.localhost');
}

export function validateServiceUrl(value, options = {}) {
  const label = options.label || 'Service URL';
  const allowRemote = options.allowRemote === true;
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    const error = new Error(`${label} must be a valid absolute URL.`);
    error.statusCode = 400;
    error.code = 'INVALID_SERVICE_URL';
    throw error;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error(`${label} must use http or https.`);
    error.statusCode = 400;
    error.code = 'INVALID_SERVICE_URL_PROTOCOL';
    throw error;
  }
  if (parsed.username || parsed.password) {
    const error = new Error(`${label} must not contain embedded credentials.`);
    error.statusCode = 400;
    error.code = 'SERVICE_URL_CREDENTIALS_FORBIDDEN';
    throw error;
  }
  if (!isLoopbackHostname(parsed.hostname) && !allowRemote) {
    const error = new Error(`${label} must be loopback unless its explicit remote-service gate is approved.`);
    error.statusCode = 403;
    error.code = 'REMOTE_SERVICE_DISABLED';
    throw error;
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}
