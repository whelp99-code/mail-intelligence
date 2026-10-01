import { readFileSync } from 'node:fs';

export const UNFILLED_SLOT = '{확인 필요}';
export const PARTNER_NAMES_PATH = 'data/config/reply-partner-names.json';
export const DEFAULT_PARTNERS = Object.freeze([
  { names: ['넥시아스', 'nexias'], domains: ['nexias.co.kr'] },
]);

const NUMBER = /(?<![A-Za-z0-9])\d[\d,]*(?:\.\d+)?(?![A-Za-z0-9])/g;

export function preserveBodyLineBreaks(bodyText) {
  if (typeof bodyText !== 'string') {
    const error = new Error('INVALID_DRAFT_TEXT');
    error.code = 'INVALID_DRAFT_TEXT';
    throw error;
  }
  if (bodyText.includes('\0')) {
    const error = new Error('INVALID_DRAFT_TEXT');
    error.code = 'INVALID_DRAFT_TEXT';
    throw error;
  }
  return bodyText;
}

export function graphTextBody(bodyText) {
  return { contentType: 'Text', content: preserveBodyLineBreaks(bodyText) };
}

function domainOf(address = '') {
  return String(address || '').toLowerCase().split('@')[1] || '';
}

export function normalizePartners(list = DEFAULT_PARTNERS) {
  return (Array.isArray(list) ? list : []).map((item) => ({
    names: [...new Set((item.names || []).map((name) => String(name || '').trim()).filter(Boolean))],
    domains: [...new Set((item.domains || []).map((domain) => String(domain || '').toLowerCase()).filter(Boolean))],
  })).filter((item) => item.names.length);
}

export function partnerLeak(bodyText, recipients = [], partners = DEFAULT_PARTNERS) {
  const text = String(bodyText || '');
  const domains = recipients.map(domainOf).filter(Boolean);
  const hits = [];
  for (const partner of normalizePartners(partners)) {
    const sameCompany = domains.some((domain) => partner.domains.includes(domain));
    if (sameCompany) continue;
    for (const name of partner.names) {
      const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (pattern.test(text)) hits.push(name);
    }
  }
  return hits;
}

export function scrubPartnerNames(bodyText, recipients = [], partners = DEFAULT_PARTNERS) {
  let body = String(bodyText || '');
  const leaks = partnerLeak(body, recipients, partners);
  for (const name of leaks) {
    body = body.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), UNFILLED_SLOT);
  }
  return { body, leaked: leaks.length > 0, names: leaks };
}

function numberTokens(value = '') {
  return [...String(value).matchAll(NUMBER)].map((match) => match[0]);
}

export function replaceUngroundedNumbers(bodyText, sources = []) {
  const allowed = new Set(sources.flatMap((source) => numberTokens(source)));
  let ungrounded = false;
  const body = String(bodyText || '').replace(NUMBER, (token) => {
    if (allowed.has(token)) return token;
    ungrounded = true;
    return UNFILLED_SLOT;
  });
  return { body, ungrounded };
}

export function draftNeedsClarification(bodyText = '') {
  return String(bodyText).includes(UNFILLED_SLOT);
}

export function loadPartnerNames(path = PARTNER_NAMES_PATH, read = readFileSync) {
  try {
    return normalizePartners(JSON.parse(read(path, 'utf8')).partners);
  } catch {
    return normalizePartners(DEFAULT_PARTNERS);
  }
}
