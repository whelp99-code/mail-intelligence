export function messageIdFromHash(hash) {
  const match = /^#m=(.+)$/.exec(String(hash || ''));
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

export function messageMatchesHash(message, id) {
  if (!id || !message) return false;
  return String(message.id) === id || String(message.databaseId ?? '') === id;
}
