CREATE TABLE IF NOT EXISTS work_links (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  object_type TEXT NOT NULL
    CHECK (object_type IN ('account', 'engagement', 'activity', 'commitment')),
  system TEXT NOT NULL
    CHECK (system IN ('notion', 'cwos')),
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'rejected', 'superseded')),
  corrected_by TEXT
    CHECK (corrected_by IS NULL OR corrected_by IN ('user', 'policy', 'codex')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, message_id, system, object_type, external_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_work_links_mailbox_status
  ON work_links(mailbox_id, status, object_type);

CREATE INDEX IF NOT EXISTS idx_work_links_message
  ON work_links(message_id, status);
