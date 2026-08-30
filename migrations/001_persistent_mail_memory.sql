CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY,
  mailbox_key TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT '',
  graph_user TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS mail_folders (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  well_known_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  parent_graph_id TEXT NOT NULL DEFAULT '',
  delta_link TEXT NOT NULL DEFAULT '',
  next_link TEXT NOT NULL DEFAULT '',
  sync_state TEXT NOT NULL DEFAULT 'idle' CHECK (sync_state IN ('idle', 'running', 'interrupted', 'failed')),
  last_sync_started_at TEXT,
  last_sync_completed_at TEXT,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, graph_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mail_folder_well_known
  ON mail_folders(mailbox_id, well_known_name)
  WHERE well_known_name <> '';

CREATE TABLE IF NOT EXISTS persons (
  id INTEGER PRIMARY KEY,
  email_norm TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  normalized_subject TEXT NOT NULL DEFAULT '',
  first_received_at TEXT,
  last_received_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, conversation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
  graph_id TEXT NOT NULL,
  internet_message_id TEXT NOT NULL DEFAULT '',
  change_key TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  normalized_subject TEXT NOT NULL DEFAULT '',
  sender_person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  sender_email TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  received_at TEXT,
  sent_at TEXT,
  graph_created_at TEXT,
  graph_modified_at TEXT,
  importance TEXT NOT NULL DEFAULT 'normal',
  inference_classification TEXT NOT NULL DEFAULT '',
  flag_status TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  is_promotional INTEGER NOT NULL DEFAULT 0 CHECK (is_promotional IN (0, 1)),
  body_preview TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  web_link TEXT NOT NULL DEFAULT '',
  parent_folder_graph_id TEXT NOT NULL DEFAULT '',
  removed_reason TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, graph_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received
  ON messages(mailbox_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_folder_received
  ON messages(folder_id, received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages(thread_id, received_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_messages_active
  ON messages(mailbox_id, deleted_at, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_internet_id
  ON messages(mailbox_id, internet_message_id)
  WHERE internet_message_id <> '';

CREATE TABLE IF NOT EXISTS message_recipients (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc', 'replyTo')),
  email_norm TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, recipient_type, email_norm)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_message_recipients_person ON message_recipients(person_id);
CREATE INDEX IF NOT EXISTS idx_message_recipients_email ON message_recipients(email_norm);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  graph_id TEXT NOT NULL,
  attachment_type TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1)),
  content_id TEXT NOT NULL DEFAULT '',
  last_modified_at TEXT,
  source_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id, graph_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS message_analysis (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('rules', 'ai', 'ai-cache', 'rules-fallback')),
  provider TEXT NOT NULL DEFAULT 'rules',
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('urgent', 'active', 'waiting', 'done', 'reference')),
  confidence REAL,
  summary_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (message_id, cache_key)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_message_analysis_message_updated
  ON message_analysis(message_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS message_feedback (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_status TEXT NOT NULL CHECK (user_status IN ('urgent', 'active', 'waiting', 'done')),
  reason_code TEXT NOT NULL DEFAULT '',
  reason_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sender_snapshot TEXT NOT NULL DEFAULT '',
  subject_snapshot TEXT NOT NULL DEFAULT '',
  subject_tokens_json TEXT NOT NULL DEFAULT '[]',
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS feedback_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_status TEXT NOT NULL CHECK (user_status IN ('urgent', 'active', 'waiting', 'done')),
  reason_code TEXT NOT NULL DEFAULT '',
  reason_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_feedback_events_message_saved
  ON feedback_events(message_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES mail_folders(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL CHECK (run_type IN ('initial', 'delta', 'resume', 'cursor-reset', 'legacy-import')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  cursor_start TEXT NOT NULL DEFAULT '',
  cursor_end TEXT NOT NULL DEFAULT '',
  pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
  items_received INTEGER NOT NULL DEFAULT 0 CHECK (items_received >= 0),
  upserts INTEGER NOT NULL DEFAULT 0 CHECK (upserts >= 0),
  deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sync_runs_folder_started
  ON sync_runs(folder_id, started_at DESC);

CREATE TABLE IF NOT EXISTS sync_pages (
  id INTEGER PRIMARY KEY,
  sync_run_id INTEGER NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  request_url_hash TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  upsert_count INTEGER NOT NULL DEFAULT 0 CHECK (upsert_count >= 0),
  deletion_count INTEGER NOT NULL DEFAULT 0 CHECK (deletion_count >= 0),
  next_link TEXT NOT NULL DEFAULT '',
  delta_link TEXT NOT NULL DEFAULT '',
  applied_at TEXT NOT NULL,
  UNIQUE (sync_run_id, page_index)
) STRICT;

CREATE TABLE IF NOT EXISTS legacy_imports (
  id INTEGER PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_digest TEXT NOT NULL UNIQUE,
  mailbox_count INTEGER NOT NULL DEFAULT 0 CHECK (mailbox_count >= 0),
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  feedback_count INTEGER NOT NULL DEFAULT 0 CHECK (feedback_count >= 0),
  analysis_count INTEGER NOT NULL DEFAULT 0 CHECK (analysis_count >= 0),
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  subject,
  body_text,
  sender_email,
  sender_name,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts(rowid, subject, body_text, sender_email, sender_name)
  VALUES (new.id, new.subject, new.body_text, new.sender_email, new.sender_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, subject, body_text, sender_email, sender_name)
  VALUES ('delete', old.id, old.subject, old.body_text, old.sender_email, old.sender_name);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF subject, body_text, sender_email, sender_name ON messages BEGIN
  INSERT INTO message_fts(message_fts, rowid, subject, body_text, sender_email, sender_name)
  VALUES ('delete', old.id, old.subject, old.body_text, old.sender_email, old.sender_name);
  INSERT INTO message_fts(rowid, subject, body_text, sender_email, sender_name)
  VALUES (new.id, new.subject, new.body_text, new.sender_email, new.sender_name);
END;
