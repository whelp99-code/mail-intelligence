CREATE TABLE precision_learning_policies (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  policy_key TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  subject_template TEXT NOT NULL DEFAULT '',
  subject_tokens_json TEXT NOT NULL DEFAULT '[]',
  overrides_json TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source_graph_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, policy_key)
) STRICT;

CREATE INDEX precision_learning_policies_sender
  ON precision_learning_policies(mailbox_id, sender_email, active);

CREATE TABLE precision_learning_policy_events (
  id INTEGER PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES precision_learning_policies(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  policy_version INTEGER NOT NULL,
  overrides_json TEXT NOT NULL,
  source_graph_id TEXT NOT NULL,
  saved_at TEXT NOT NULL
) STRICT;

CREATE INDEX precision_learning_policy_events_policy
  ON precision_learning_policy_events(policy_id, policy_version DESC);
