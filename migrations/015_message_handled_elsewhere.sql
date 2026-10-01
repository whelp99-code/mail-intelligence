CREATE TABLE message_handled_elsewhere (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('kakao', 'phone', 'in_person', 'other')),
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  undone_at TEXT
) STRICT;

CREATE INDEX message_handled_elsewhere_mailbox
  ON message_handled_elsewhere(mailbox_id, undone_at);
