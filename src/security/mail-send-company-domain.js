const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function invalidConfiguration() {
  const error = new Error('MAIL_COMPANY_DOMAIN_INVALID');
  Object.assign(error, { code: 'MAIL_COMPANY_DOMAIN_INVALID' });
  throw error;
}

export function normalizeCompanyDomains(value) {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : invalidConfiguration();
  if (String(raw).trim() === '') return null;
  const items = String(raw).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (items.length === 0 || items.some((item) => !DOMAIN_PATTERN.test(item))) invalidConfiguration();
  return Object.freeze([...new Set(items)]);
}

export function companyDomainsFromEnvironment(env = process.env) {
  if (!Object.hasOwn(env, 'MAIL_INTELLIGENCE_COMPANY_DOMAINS')) return null;
  return normalizeCompanyDomains(env.MAIL_INTELLIGENCE_COMPANY_DOMAINS);
}

export function externalRecipientAddresses({ to = [], cc = [] } = {}, companyDomains) {
  const recipients = [...to, ...cc].map((address) => String(address).trim()).filter(Boolean);
  if (companyDomains == null || companyDomains.length === 0) return recipients;
  const allowed = new Set(companyDomains);
  return recipients.filter((address) => {
    const at = address.lastIndexOf('@');
    if (at <= 0 || at !== address.indexOf('@') || at === address.length - 1) return true;
    return !allowed.has(address.slice(at + 1).toLowerCase());
  });
}

export function assertExternalRecipientConfirmed(draft, companyDomains, confirmed) {
  if (!externalRecipientAddresses(draft, companyDomains).length || confirmed === true) return;
  const error = new Error('EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED');
  Object.assign(error, { code: 'EXTERNAL_RECIPIENT_CONFIRMATION_REQUIRED', statusCode: 403 });
  throw error;
}
