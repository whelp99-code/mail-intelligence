CREATE TABLE mail_send_reconciliation_jobs (
  draft_id TEXT PRIMARY KEY REFERENCES mail_send_drafts(draft_id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'complete')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT,
  last_failure_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX mail_send_reconciliation_due
  ON mail_send_reconciliation_jobs(state, next_attempt_at);
CREATE INDEX mail_send_reconciliation_mailbox
  ON mail_send_reconciliation_jobs(mailbox_id, state, next_attempt_at);
