export function messageIdFromHash(hash) {
  const match = /^#m=(.+)$/.exec(String(hash || ''));
  if (!match) return '';
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
