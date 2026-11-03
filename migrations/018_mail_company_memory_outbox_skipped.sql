CREATE TABLE mail_company_memory_outbox_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INBOX_RECEIVED', 'WORK_LINKED', 'WORK_LINK_CORRECTED')),
  provider TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  source_locator TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  work_item_id TEXT,
  link_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'EMITTED', 'SKIPPED')),
  skip_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind, provider, mailbox, source_locator, source_event_id),
  CHECK (status <> 'SKIPPED' OR (skip_reason IS NOT NULL AND skip_reason <> ''))
) STRICT;

INSERT INTO mail_company_memory_outbox_next (
  id, workspace_id, kind, provider, mailbox, source_locator, source_event_id,
  work_item_id, link_id, status, skip_reason, version, created_at, updated_at
)
SELECT
  id, workspace_id, kind, provider, mailbox, source_locator, source_event_id,
  work_item_id, link_id, status, NULL, version, created_at, updated_at
FROM mail_company_memory_outbox;

DROP TABLE mail_company_memory_outbox;
ALTER TABLE mail_company_memory_outbox_next RENAME TO mail_company_memory_outbox;

CREATE INDEX mail_company_memory_outbox_pending
  ON mail_company_memory_outbox(workspace_id, status, created_at);
