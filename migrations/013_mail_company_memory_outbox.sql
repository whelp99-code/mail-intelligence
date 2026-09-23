CREATE TABLE mail_company_memory_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INBOX_RECEIVED', 'WORK_LINKED', 'WORK_LINK_CORRECTED')),
  provider TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  work_item_id TEXT,
  link_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'EMITTED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind, provider, mailbox, source_locator, source_event_id)
) STRICT;

CREATE INDEX mail_company_memory_outbox_pending
  ON mail_company_memory_outbox(workspace_id, status, created_at);
