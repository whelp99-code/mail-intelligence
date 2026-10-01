import { parseDriveLink } from './drive-links.js';

export const DRIVE_LINK_SUGGESTION_BYTES = 2 * 1024 * 1024;
const STOP = new Set(['re', 'fw', 'fwd', '요청', '회신', '안내', '관련', '건', '메일', '확인']);

export function keywordsFrom(text = '') {
  return [...new Set(String(text || '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP.has(token.toLowerCase())))].slice(0, 8);
}

function tableExists(db, name) {
  return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(name));
}

function driveUrl(fileId) {
  const url = `https://drive.google.com/file/d/${fileId}/view`;
  return parseDriveLink(url).url;
}

export function suggestReplyAttachments({ db, message = {}, recipient = '', keywords = [] } = {}) {
  if (!db) return [];
  const terms = keywords.length ? keywords : keywordsFrom(`${message.subject || ''} ${message.body_text || message.body || ''}`);
  const suggestions = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.kind}:${item.name}:${item.url || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push({ ...item, autoAttach: false });
  };
  if (tableExists(db, 'attachments') && message.id) {
    const rows = db.prepare(`
      SELECT name, size_bytes, message_id FROM attachments
      WHERE message_id = ? AND COALESCE(is_inline, 0) = 0
    `).all(message.id);
    for (const row of rows) {
      push({
        kind: 'thread_file',
        name: row.name,
        size: Number(row.size_bytes || 0),
        messageId: row.message_id,
        reason: '원본 스레드 첨부',
      });
    }
  }
  if (tableExists(db, 'attachments') && tableExists(db, 'message_recipients') && recipient) {
    const like = terms.slice(0, 4).map((term) => `%${term}%`);
    if (like.length) {
      const clause = like.map(() => 'a.name LIKE ?').join(' OR ');
      const rows = db.prepare(`
        SELECT a.name, a.size_bytes, m.id AS message_id
        FROM messages m
        JOIN mail_folders f ON f.id = m.folder_id
        JOIN message_recipients r ON r.message_id = m.id AND r.recipient_type = 'to'
        JOIN attachments a ON a.message_id = m.id
        WHERE lower(r.email_norm) = ? AND lower(COALESCE(f.well_known_name, '')) IN ('sentitems', 'sent')
          AND (${clause})
        LIMIT 5
      `).all(recipient.toLowerCase(), ...like);
      for (const row of rows) {
        push({
          kind: 'recent_sent',
          name: row.name,
          size: Number(row.size_bytes || 0),
          messageId: row.message_id,
          reason: '같은 수신자 최근 발신 첨부',
        });
      }
    }
  }
  if (tableExists(db, 'mail_attachment_assets') && terms.length) {
    const like = terms.slice(0, 4).map((term) => `%${term}%`);
    const clause = like.map(() => 'display_name LIKE ?').join(' OR ');
    const rows = db.prepare(`
      SELECT display_name, byte_length, drive_file_id
      FROM mail_attachment_assets
      WHERE origin = 'drive' AND drive_file_id IS NOT NULL AND byte_length > ? AND (${clause})
      LIMIT 5
    `).all(DRIVE_LINK_SUGGESTION_BYTES, ...like);
    for (const row of rows) {
      push({
        kind: 'drive_link',
        name: row.display_name,
        size: Number(row.byte_length),
        url: driveUrl(row.drive_file_id),
        reason: '2MB 초과 색인 Drive 파일. 링크 제안만 하며 자동 첨부하지 않습니다.',
      });
    }
  }
  return suggestions;
}
