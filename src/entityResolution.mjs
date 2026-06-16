/**
 * Rule-based entity resolution: external domains → customer/partner hints.
 */

const PARTNER_RE = /partner|협력|총판|vendor|reseller|distributor|channel/i;
const CUSTOMER_RE = /견적|quote|po\b|invoice|고객|구매|발주|계약|poc|제안/i;
const INTERNAL_RE = /^(gmail|outlook|hotmail|naver|daum|kakao|yahoo)\./i;

export function emailAddress(value = '') {
  return String(value).match(/<([^>]+)>/)?.[1]?.trim() || String(value).trim();
}

export function domainFromAddress(from = '') {
  const email = emailAddress(from).toLowerCase();
  return email.split('@')[1] || '';
}

export function domainRootName(domain = '') {
  const parts = String(domain).toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return domain;
  return parts[parts.length - 2];
}

function collectInternalDomains(mailboxUser = '', extra = []) {
  const domains = new Set(
    [mailboxUser, ...extra]
      .map((value) => domainFromAddress(value))
      .filter(Boolean)
  );
  return domains;
}

function isPublicMailboxDomain(domain) {
  return INTERNAL_RE.test(domain);
}

export function resolveEntityForMessage(message, options = {}) {
  const internalDomains = collectInternalDomains(options.mailboxUser, options.internalDomains);
  const domain = domainFromAddress(message?.from || '');
  if (!domain || internalDomains.has(domain) || isPublicMailboxDomain(domain)) {
    return null;
  }

  const blob = `${message.subject || ''} ${message.bodyPreview || ''} ${message.body || ''}`.toLowerCase();
  let entityRole = 'customer';
  let confidence = 0.55;

  if (PARTNER_RE.test(blob)) {
    entityRole = 'partner';
    confidence = 0.78;
  } else if (CUSTOMER_RE.test(blob)) {
    entityRole = 'customer';
    confidence = 0.72;
  }

  return {
    domain,
    email: emailAddress(message.from || ''),
    candidateName: message.fromName || domainRootName(domain) || domain,
    entityRole,
    confidence,
    sourceMessageId: message.id
  };
}

export function toEntityCandidates({
  messages = [],
  threadGroups = [],
  mailboxUser = ''
}) {
  const internalDomains = collectInternalDomains(mailboxUser);
  const byDomain = new Map();

  for (const message of messages) {
    const domain = domainFromAddress(message.from || '');
    if (!domain || internalDomains.has(domain) || isPublicMailboxDomain(domain)) continue;

    const hint = resolveEntityForMessage(message, { mailboxUser });
    if (!hint) continue;

    const current = byDomain.get(domain) || {
      domain,
      email: hint.email,
      candidateName: hint.candidateName,
      entityRole: hint.entityRole,
      confidence: hint.confidence,
      messageCount: 0,
      threadKeys: new Set(),
      sampleSubjects: []
    };

    current.messageCount += 1;
    current.confidence = Math.max(current.confidence, hint.confidence);
    if (hint.entityRole === 'partner') current.entityRole = 'partner';
    if (message.aiGroupKey) current.threadKeys.add(message.aiGroupKey);
    if (current.sampleSubjects.length < 3 && message.subject) {
      current.sampleSubjects.push(message.subject);
    }
    byDomain.set(domain, current);
  }

  for (const group of threadGroups || []) {
    const domains = (group.participants || [])
      .map((address) => domainFromAddress(address))
      .filter((domain) => domain && !internalDomains.has(domain));
    const blob = `${group.label || ''}`.toLowerCase();
    for (const domain of domains) {
      const current = byDomain.get(domain);
      if (!current) continue;
      if (PARTNER_RE.test(blob)) {
        current.entityRole = 'partner';
        current.confidence = Math.max(current.confidence, 0.8);
      }
      if (group.key) current.threadKeys.add(group.key);
    }
  }

  return [...byDomain.values()]
    .map((entry) => ({
      email: entry.email,
      domain: entry.domain,
      candidateName: entry.candidateName,
      entityRole: entry.entityRole,
      confidence: Math.min(0.95, entry.confidence + Math.min(entry.messageCount, 5) * 0.03),
      messageCount: entry.messageCount,
      threadCount: entry.threadKeys.size,
      sampleSubjects: entry.sampleSubjects
    }))
    .sort((a, b) => b.confidence - a.confidence || b.messageCount - a.messageCount)
    .slice(0, 40);
}
