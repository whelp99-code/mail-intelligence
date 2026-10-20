CREATE TABLE browser_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  access_key_binding TEXT NOT NULL
) STRICT;

CREATE INDEX browser_sessions_binding_created
  ON browser_sessions(access_key_binding, created_at);
