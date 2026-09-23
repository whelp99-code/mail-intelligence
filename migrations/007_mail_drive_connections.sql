CREATE TABLE mail_drive_connections (
  id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  provider_subject TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (mailbox_id, provider_subject)
) STRICT;

CREATE TABLE mail_drive_file_grants (
  connection_id TEXT NOT NULL REFERENCES mail_drive_connections(id),
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  file_id TEXT NOT NULL,
  resource_key_encrypted TEXT,
  selected_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (connection_id, file_id)
) STRICT;

CREATE INDEX mail_drive_connections_mailbox ON mail_drive_connections(mailbox_id, revoked_at);
CREATE INDEX mail_drive_file_grants_mailbox ON mail_drive_file_grants(mailbox_id, revoked_at);
