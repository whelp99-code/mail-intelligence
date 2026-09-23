// Called only for pending 009 after the exact attachment 006 is applied.
// The caller owns the migration transaction and history insertion; never disable FKs.
export function bridgeAttachmentDraftPrincipals(db, source) {
  const drafts = 'draft_id, digest_version, links_json';
  const bindings = 'draft_id, ordinal, asset_id, frozen_name, frozen_mime, frozen_size, frozen_sha256';
  db.exec(`
    CREATE TEMP TABLE attachment_bridge_drafts AS
      SELECT ${drafts} FROM mail_send_drafts;
    CREATE TEMP TABLE attachment_bridge_bindings AS
      SELECT ${bindings} FROM mail_draft_attachments;
    DELETE FROM mail_draft_attachments;
  `);

  // Execute the immutable migration, including its approval/event preservation.
  db.exec(source);
  db.exec(`
    ALTER TABLE mail_send_drafts ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE mail_send_drafts ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
    UPDATE mail_send_drafts SET
      digest_version = saved.digest_version,
      links_json = saved.links_json
    FROM temp.attachment_bridge_drafts AS saved
    WHERE mail_send_drafts.draft_id = saved.draft_id;
    INSERT INTO mail_draft_attachments (${bindings})
      SELECT ${bindings} FROM temp.attachment_bridge_bindings;
  `);

  // Compare raw SQL values in both directions, not parsed JSON or just row counts.
  for (const [columns, table, snapshot] of [
    [drafts, 'mail_send_drafts', 'attachment_bridge_drafts'],
    [bindings, 'mail_draft_attachments', 'attachment_bridge_bindings'],
  ]) {
    const changed = db.prepare(`
      SELECT EXISTS (
        SELECT ${columns} FROM ${table}
        EXCEPT SELECT ${columns} FROM temp.${snapshot}
      ) OR EXISTS (
        SELECT ${columns} FROM temp.${snapshot}
        EXCEPT SELECT ${columns} FROM ${table}
      ) AS changed
    `).get().changed;
    if (changed) throw new Error(`Attachment migration preservation failed: ${table}.`);
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('Attachment migration foreign key integrity failed.');
  }
  db.exec(`
    DROP TABLE temp.attachment_bridge_bindings;
    DROP TABLE temp.attachment_bridge_drafts;
  `);
}
