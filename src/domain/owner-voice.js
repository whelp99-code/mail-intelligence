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

export function applyOwnerVoice(body, { profile, recipients = [] } = {}) {
  if (!profile) return { body: String(body || ''), voiceVersion: '', formality: '' };
  const formality = formalityFor(profile, recipients);
  let next = String(body || '');
  const greeting = (profile.greetings || []).find((item) => item.id === (formality === 'formal' ? 'formal-hello' : 'standard-hello'));
  if (formality === 'formal' && greeting?.pattern) {
    next = next.replace('안녕하세요', greeting.pattern);
  }
  const signature = profile.signature?.block;
  if (signature) next = next.replaceAll('{기본 서명}', signature);
  return { body: next, voiceVersion: profile.version, formality };
}
