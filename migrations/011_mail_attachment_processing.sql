CREATE TABLE mail_attachment_processing (
  attachment_id INTEGER PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL DEFAULT '',
  quarantine_state TEXT NOT NULL CHECK (quarantine_state IN ('quarantined', 'released', 'expired')),
  scan_state TEXT NOT NULL CHECK (scan_state IN ('pending', 'clean', 'infected', 'unavailable', 'unsupported', 'timeout')),
  extraction_state TEXT NOT NULL CHECK (extraction_state IN ('not_requested', 'pending', 'authorized', 'complete', 'rejected')),
  scanner TEXT NOT NULL DEFAULT '',
  scanner_version TEXT NOT NULL DEFAULT '',
  parser TEXT NOT NULL DEFAULT '',
  parser_version TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX mail_attachment_processing_mailbox ON mail_attachment_processing(mailbox_id, scan_state, extraction_state);
