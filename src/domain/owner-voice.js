import { readFileSync } from 'node:fs';

export const OWNER_VOICE_PATH = 'data/config/owner-voice-profile.v1.json';

export function loadOwnerVoiceProfile(path = OWNER_VOICE_PATH, read = readFileSync) {
  const profile = JSON.parse(read(path, 'utf8'));
  if (profile.version !== 'owner-voice-profile-v1') {
    throw new Error('unsupported owner voice profile');
  }
  return profile;
}

function domainOf(address = '') {
  return String(address || '').toLowerCase().split('@')[1] || '';
}

export function formalityFor(profile, recipients = []) {
  const domains = recipients.map(domainOf).filter(Boolean);
  for (const domain of domains) {
    const level = profile?.formalityByDomain?.[domain];
    if (level) return level;
  }
  return profile?.defaultFormality || 'standard';
}

function ownerAuthoredText(message = {}) {
  const source = String(message.body_text || message.body || '').replace(/\r/g, '');
  const lines = [];
  let quoted = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (/^(?:[-_ ]{2,})?(?:원본\s*메시지|보낸\s*사람|보낸\s*날짜|받는\s*사람|참조|from:|sent:|to:|cc:|subject:|begin forwarded message)/i.test(trimmed)
      || /^-{2,}.*(?:original|forwarded) message.*-{2,}$/i.test(trimmed)
      || /^(?:>|원문\s*:|전달된\s*메시지)/.test(trimmed)) quoted = true;
    if (quoted) continue;
    if (/^\s*(?:>|\|)/.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function patternCandidate(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 100 || /[0-9@]|https?:\/\//i.test(text)) return '';
  return text;
}

function frequentPatterns(values, limit = 3) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts]
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right, 'ko'))
    .slice(0, limit)
    .map(([pattern, count], index) => ({ id: `learned-${index + 1}`, pattern, count, examples: [] }));
}

export function deriveOwnerVoiceProfile(sentMessages = [], baseProfile) {
  if (!baseProfile) throw new TypeError('base owner voice profile is required');
  const messages = Array.isArray(sentMessages) ? sentMessages : [];
  const greetings = [];
  const closings = [];
  const politeEndings = [];
  const evidenceIds = [];
  for (const message of messages) {
    const text = ownerAuthoredText(message);
    if (!text) continue;
    if (message.id != null) evidenceIds.push(String(message.id));
    const greeting = text.split('\n').slice(0, 3).join('\n').match(/안녕하세요|안녕하십니까/)?.[0];
    if (greeting) greetings.push(greeting);
    const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-4);
    const closing = [...tail].reverse().find((line) => /(?:감사합니다|고맙습니다|드림|올림)[.!。]?$/.test(line)) || '';
    if (closing) closings.push(patternCandidate(closing));
    for (const line of tail) {
      const ending = line.match(/(?:부탁드립니다|감사합니다|고맙습니다|드립니다|바랍니다|습니다|드림|올림)[.!。]?$/)?.[0];
      if (ending) politeEndings.push(patternCandidate(ending));
    }
  }
  return {
    ...baseProfile,
    greetings: frequentPatterns(greetings).length ? frequentPatterns(greetings) : baseProfile.greetings,
    closings: frequentPatterns(closings).length ? frequentPatterns(closings) : baseProfile.closings,
    sentenceEndings: frequentPatterns(politeEndings, 6).length
      ? frequentPatterns(politeEndings, 6).map((item) => item.pattern)
      : baseProfile.sentenceEndings,
    builtFrom: {
      ...(baseProfile.builtFrom || {}),
      source: 'owner-sent-items',
      messageCount: messages.length,
      evidenceIds: [...new Set(evidenceIds)].sort(),
    },
  };
}

export function applyOwnerVoice(body, { profile, recipients = [] } = {}) {
  if (!profile) return { body: String(body || ''), voiceVersion: '', formality: '' };
  const formality = formalityFor(profile, recipients);
  let next = String(body || '');
  const explicitSalutation = recipients
    .map(domainOf)
    .map((domain) => profile.salutationsByDomain?.[domain])
    .find(Boolean);
  const greeting = (profile.greetings || []).find((item) => item.id === (formality === 'formal' ? 'formal-hello' : 'standard-hello'))
    || profile.greetings?.[0];
  const greetingText = greeting?.pattern;
  const headerHasGreeting = /안녕하세요|안녕하십니까/.test(next.split('\n').slice(0, 3).join('\n'));
  if (greetingText && headerHasGreeting) next = next.replace(/안녕하세요|안녕하십니까/, greetingText);
  if (explicitSalutation) {
    const lines = next.split('\n');
    const firstLine = lines[0] || '';
    const greetingMatch = firstLine.match(/안녕하세요|안녕하십니까/);
    if (greetingMatch) {
      const greetingStart = greetingMatch.index;
      lines[0] = greetingStart === 0
        ? `${explicitSalutation}, ${firstLine}`
        : `${explicitSalutation}, ${firstLine.slice(greetingStart)}`;
      next = lines.join('\n');
    } else {
      next = `${explicitSalutation}\n${next}`;
    }
  }
  if (greetingText && !headerHasGreeting) {
    next = `${greetingText}\n\n${next.trim()}`;
  }
  const closing = (profile.closings || []).find((item) => item.id === (formality === 'formal' ? 'formal-thanks' : 'thanks-dream'))
    || (profile.closings || [])[0];
  const signature = profile.signature?.block;
  if (signature) {
    next = next.replaceAll('{기본 서명}', signature);
    const firstSignature = next.indexOf(signature);
    if (firstSignature >= 0) {
      const before = next.slice(0, firstSignature + signature.length);
      const after = next.slice(firstSignature + signature.length).split(signature).join('');
      next = `${before}${after}`;
    }
  }
  const closingText = closing?.pattern;
  if (closingText) {
    const footer = signature && next.endsWith(signature) ? signature : '';
    const content = footer ? next.slice(0, -footer.length).trimEnd() : next.trimEnd();
    const ending = /(?:감사합니다|고맙습니다|감사드립니다)[.!]?(?:\n[^\n]{1,30}\s*(?:드림|올림))?$|[^\n]{1,30}\s+(?:드림|올림)$/;
    const text = /^(?:감사합니다|고맙습니다|감사드립니다)$/.test(closingText) ? `${closingText}.` : closingText;
    const closed = content.endsWith(text) ? content : ending.test(content)
      ? content.replace(ending, text) : `${content}\n\n${text}`;
    next = footer ? `${closed}\n\n${footer}` : closed;
  }
  return { body: next, voiceVersion: profile.version, formality };
}
