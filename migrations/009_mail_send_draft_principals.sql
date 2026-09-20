CREATE TABLE mail_send_drafts_next (
  draft_id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  request_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('grok-bot', 'ui', 'jarvis')),
  owner_principal TEXT NOT NULL CHECK (
    (source = 'ui' AND owner_principal = 'human:ui')
    OR (source = 'grok-bot' AND owner_principal = 'agent:grok-bot')
    OR (source = 'jarvis' AND owner_principal = 'agent:jarvis')
  ),
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

INSERT INTO mail_send_drafts_next (
  draft_id, mailbox_id, request_id, source, owner_principal, message_id,
  to_json, cc_json, subject, body_text, payload_digest, status, created_at,
  approved_at, approved_by, sent_at, graph_message_id, failure_reason
)
SELECT
  draft_id, mailbox_id, request_id, source,
  CASE source
    WHEN 'ui' THEN 'human:ui'
    ELSE 'agent:grok-bot'
  END,
  message_id, to_json, cc_json, subject, body_text, payload_digest, status, created_at,
  approved_at, approved_by, sent_at, graph_message_id, failure_reason
FROM mail_send_drafts;

CREATE TABLE mail_send_draft_events_next (
  id INTEGER PRIMARY KEY,
  draft_id TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
) STRICT;

INSERT INTO mail_send_draft_events_next (id, draft_id, status, actor, created_at, reason)
SELECT id, draft_id, status, actor, created_at, reason FROM mail_send_draft_events;

DROP TABLE mail_send_draft_events;
DROP TABLE mail_send_drafts;
ALTER TABLE mail_send_drafts_next RENAME TO mail_send_drafts;

CREATE TABLE mail_send_draft_events (
  id INTEGER PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES mail_send_drafts(draft_id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
) STRICT;

INSERT INTO mail_send_draft_events (id, draft_id, status, actor, created_at, reason)
SELECT id, draft_id, status, actor, created_at, reason FROM mail_send_draft_events_next;

DROP TABLE mail_send_draft_events_next;

CREATE INDEX mail_send_drafts_review ON mail_send_drafts(mailbox_id, status, created_at);
CREATE INDEX mail_send_drafts_owner ON mail_send_drafts(mailbox_id, owner_principal, created_at);
