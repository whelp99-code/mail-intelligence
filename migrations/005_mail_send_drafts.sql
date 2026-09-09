CREATE TABLE mail_send_drafts (
  draft_id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  request_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('grok-bot', 'ui')),
  message_id INTEGER REFERENCES messages(id),
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('needs_approval', 'needs_clarification', 'approved', 'sending', 'sent', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  sent_at TEXT,
  graph_message_id TEXT,
  failure_reason TEXT,
  UNIQUE(mailbox_id, source, request_id),
  CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND graph_message_id IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'sending', 'sent') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
) STRICT;

CREATE TABLE mail_send_draft_events (
  id INTEGER PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES mail_send_drafts(draft_id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX mail_send_drafts_review ON mail_send_drafts(mailbox_id, status, created_at);
