ALTER TABLE mail_send_drafts ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mail_send_drafts ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE mail_attachment_assets (
  id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  source TEXT NOT NULL CHECK (source IN ('ui', 'grok-bot')),
  request_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  ciphertext BLOB,
  nonce BLOB,
  auth_tag BLOB,
  key_version TEXT NOT NULL,
  encryption_aad_version TEXT NOT NULL,
  encryption_policy_version TEXT NOT NULL,
  scan_policy_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged', 'ready', 'rejected', 'expired')),
  scan_engine TEXT,
  scan_version TEXT,
  scanned_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('local', 'drive')),
  drive_connection_id TEXT,
  drive_file_id TEXT,
  drive_resource_key BLOB,
  drive_version TEXT,
  drive_modified_time TEXT,
  export_mime TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  UNIQUE(mailbox_id, source, request_id),
  CHECK (state <> 'ready' OR (ciphertext IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL))
) STRICT;

CREATE TABLE mail_draft_attachments (
  draft_id TEXT NOT NULL REFERENCES mail_send_drafts(draft_id),
  ordinal INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES mail_attachment_assets(id),
  frozen_name TEXT NOT NULL,
  frozen_mime TEXT NOT NULL,
  frozen_size INTEGER NOT NULL,
  frozen_sha256 TEXT NOT NULL,
  PRIMARY KEY (draft_id, ordinal),
  UNIQUE (draft_id, asset_id)
) STRICT;

CREATE TABLE mail_attachment_reservations (
  id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  source TEXT NOT NULL CHECK (source IN ('ui', 'grok-bot')),
  request_id TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
) STRICT;

CREATE INDEX mail_attachment_assets_mailbox_state ON mail_attachment_assets(mailbox_id, state, created_at);
CREATE INDEX mail_draft_attachments_asset ON mail_draft_attachments(asset_id);
CREATE INDEX mail_attachment_reservations_mailbox ON mail_attachment_reservations(mailbox_id, released_at);
CREATE UNIQUE INDEX mail_attachment_reservations_inflight
  ON mail_attachment_reservations(mailbox_id, source, request_id)
  WHERE released_at IS NULL;
