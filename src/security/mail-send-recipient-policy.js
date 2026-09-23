const ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;

function invalidConfiguration() {
  const error = new Error('MAIL_INTELLIGENCE_SEND_RECIPIENT_ALLOWLIST must contain one or more valid comma-separated email addresses.');
  error.code = 'MAIL_SEND_RECIPIENT_ALLOWLIST_INVALID';
  throw error;
}

function normalizeAddress(value) {
  if (typeof value !== 'string') invalidConfiguration();
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !ADDRESS_PATTERN.test(normalized)) invalidConfiguration();
  return normalized;
}

export function normalizeMailSendRecipientAllowlist(value) {
  if (value == null) return null;
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(items) || items.length === 0) invalidConfiguration();
  const normalized = items.map((item) => normalizeAddress(item));
  if (normalized.length === 0 || normalized.some((item) => !item)) invalidConfiguration();
  return Object.freeze([...new Set(normalized)]);
}

export function mailSendRecipientAllowlistFromEnvironment(env = process.env) {
  if (!Object.hasOwn(env, 'MAIL_INTELLIGENCE_SEND_RECIPIENT_ALLOWLIST')) return null;
  return normalizeMailSendRecipientAllowlist(env.MAIL_INTELLIGENCE_SEND_RECIPIENT_ALLOWLIST);
}

export function assertMailSendRecipientsAllowed(recipientAllowlist, { to = [], cc = [] } = {}) {
  if (recipientAllowlist == null) return;
  const allowed = new Set(recipientAllowlist);
  const recipients = [...to, ...cc].map((address) => String(address).trim().toLowerCase());
  if (recipients.some((address) => !allowed.has(address))) {
    const error = new Error('RECIPIENT_NOT_ALLOWED');
    Object.assign(error, { code: 'RECIPIENT_NOT_ALLOWED', statusCode: 403 });
    throw error;
  }
}
