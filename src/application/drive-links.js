export const DRIVE_LINK_WARNING = '파일 첨부가 아닌 링크이며 수신자의 접근 권한은 확인되지 않았습니다.';
const FILE = /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view$/;
const DOCS = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)(?:\/[A-Za-z0-9._~%-]*)?$/;

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function escapeLinkLabel(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function parseDriveLink(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('\r') || value.includes('\n') || value.includes('\0')) fail(422, 'INVALID_DRIVE_LINK');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    fail(422, 'INVALID_DRIVE_LINK');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) fail(422, 'INVALID_DRIVE_LINK');
  if (!['drive.google.com', 'docs.google.com'].includes(parsed.hostname)) fail(422, 'INVALID_DRIVE_LINK');
  if (parsed.pathname.includes('..') || parsed.pathname.includes('//')) fail(422, 'INVALID_DRIVE_LINK');
  const resourceKey = parsed.searchParams.get('resourcekey') || parsed.searchParams.get('resourceKey');
  if (resourceKey && !/^[A-Za-z0-9._-]{1,256}$/.test(resourceKey)) fail(422, 'INVALID_DRIVE_LINK');
  const pathUrl = `${parsed.origin}${parsed.pathname}`;
  const file = pathUrl.match(FILE);
  const docs = pathUrl.match(DOCS);
  if (parsed.hostname === 'drive.google.com' && !file) fail(422, 'INVALID_DRIVE_LINK');
  if (parsed.hostname === 'docs.google.com' && !docs) fail(422, 'INVALID_DRIVE_LINK');
  const canonical = pathUrl + (resourceKey ? `?resourcekey=${encodeURIComponent(resourceKey)}` : '');
  return {
    url: canonical,
    file_id: file?.[1] || docs?.[2],
    kind: file ? 'file' : docs[1],
    resource_key: resourceKey || null,
  };
}

export function normalizeDriveLinks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) fail(422, 'INVALID_DRIVE_LINK');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(422, 'INVALID_DRIVE_LINK');
    const parsed = parseDriveLink(item.url);
    if (item.access_acknowledged !== true) fail(422, 'INVALID_DRIVE_LINK');
    const label = typeof item.label === 'string' ? item.label.normalize('NFC').trim().slice(0, 180) : parsed.file_id;
    if (label.includes('\r') || label.includes('\n') || label.includes('\0')) fail(422, 'INVALID_DRIVE_LINK');
    return {
      url: parsed.url,
      label,
      access_acknowledged: true,
      file_id: parsed.file_id,
      kind: parsed.kind,
    };
  });
}

export function renderDriveLinks(links) {
  if (!links.length) return '';
  const lines = links.map((item) => `- ${escapeLinkLabel(item.label)}: ${item.url}`);
  return `\n\n---\nGoogle Drive 링크 (${DRIVE_LINK_WARNING.slice(0, -1)}.)\n${lines.join('\n')}\n`;
}

export function digestDriveLinks(links) {
  return links.map((item) => ({
    url: item.url,
    label: item.label,
    access_acknowledged: true,
  }));
}
