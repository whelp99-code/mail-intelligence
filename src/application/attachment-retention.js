const DAY = 24 * 60 * 60 * 1000;
const RETAIN_AFTER_TERMINAL_MS = 30 * DAY;

function fail(statusCode, code) {
  throw Object.assign(new Error(code), { statusCode, code });
}

function terminalAt(db, draft) {
  if (draft.status === 'sent' && draft.sent_at) return draft.sent_at;
  const row = db.prepare(`
    SELECT created_at FROM mail_send_draft_events
    WHERE draft_id=? AND status IN ('cancelled','failed','sent')
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(draft.draft_id);
  return row?.created_at || null;
}

export function planAttachmentRetention(db, { now = () => new Date().toISOString(), apply = false } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const currentMs = Date.parse(current);
  const assets = db.prepare(`
    SELECT * FROM mail_attachment_assets WHERE state IN ('staged','ready','rejected')
  `).all();
  const candidates = [];
  for (const asset of assets) {
    const links = db.prepare(`
      SELECT s.draft_id, s.status, s.sent_at
      FROM mail_draft_attachments d
      JOIN mail_send_drafts s ON s.draft_id = d.draft_id
      WHERE d.asset_id=?
    `).all(asset.id);
    if (links.some((draft) => ['approved', 'sending', 'needs_approval'].includes(draft.status))) continue;
    if (!links.length) {
      if (asset.expires_at && Date.parse(asset.expires_at) <= currentMs) {
        candidates.push({ id: asset.id, reason: 'unlinked-expired', mailbox_id: asset.mailbox_id });
      }
      continue;
    }
    const times = links.map((draft) => terminalAt(db, draft)).filter(Boolean).map((value) => Date.parse(value));
    if (!times.length) continue;
    if (Math.max(...times) + RETAIN_AFTER_TERMINAL_MS <= currentMs) {
      candidates.push({ id: asset.id, reason: 'terminal-retained', mailbox_id: asset.mailbox_id });
    }
  }
  if (apply) {
    const clear = db.prepare(`
      UPDATE mail_attachment_assets
      SET state='expired', ciphertext=NULL, nonce=NULL, auth_tag=NULL
      WHERE id=?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of candidates) clear.run(item.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { dryRun: !apply, count: candidates.length, candidates };
}

export function assertRetentionSafe(apply, approved) {
  if (apply && approved !== true) fail(403, 'RETENTION_APPLY_FORBIDDEN');
}
