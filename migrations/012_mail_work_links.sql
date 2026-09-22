CREATE TABLE mail_work_links (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  system TEXT NOT NULL CHECK (system IN ('cwos', 'notion')),
  object_type TEXT NOT NULL CHECK (object_type IN ('account', 'engagement', 'activity', 'commitment')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  corrected_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mailbox_id, message_id, system, object_type, external_id)
) STRICT;

CREATE INDEX mail_work_links_message ON mail_work_links(mailbox_id, message_id, status);
