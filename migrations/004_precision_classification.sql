CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_by TEXT NOT NULL DEFAULT 'user'
    CHECK (created_by IN ('user', 'import')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mailbox_id, project_key),
  UNIQUE (mailbox_id, normalized_name)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_projects_mailbox_status
  ON projects(mailbox_id, status, normalized_name);

CREATE TABLE IF NOT EXISTS precision_classifications (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  work_state TEXT NOT NULL
    CHECK (work_state IN (
      'action_required', 'waiting', 'decision_required',
      'completed', 'reference', 'review_required'
    )),
  next_actor TEXT NOT NULL
    CHECK (next_actor IN (
      'me', 'internal_team', 'external_party',
      'shared', 'none', 'unknown'
    )),
  priority TEXT NOT NULL
    CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  due_text TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  due_precision TEXT NOT NULL DEFAULT 'none'
    CHECK (due_precision IN ('exact', 'date', 'relative', 'ambiguous', 'none')),
  primary_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_resolution TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (project_resolution IN ('confirmed', 'candidate', 'unassigned', 'review_required')),
  project_candidate_json TEXT NOT NULL DEFAULT '{}',
  signals_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  confidence_json TEXT NOT NULL DEFAULT '{}',
  review_reasons_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'rules'
    CHECK (source IN ('rules', 'ai', 'hybrid', 'user-corrected')),
  provider TEXT NOT NULL DEFAULT 'rules',
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'auto'
    CHECK (review_status IN ('auto', 'review_required', 'confirmed', 'corrected')),
  fingerprint TEXT NOT NULL,
  analyzed_at TEXT NOT NULL,
  corrected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_precision_classifications_mailbox_state
  ON precision_classifications(mailbox_id, work_state, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_precision_classifications_actor
  ON precision_classifications(mailbox_id, next_actor, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_precision_classifications_due
  ON precision_classifications(mailbox_id, due_at, work_state)
  WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_precision_classifications_project
  ON precision_classifications(primary_project_id, updated_at DESC)
  WHERE primary_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_precision_classifications_review
  ON precision_classifications(mailbox_id, review_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS precision_classification_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  work_state TEXT NOT NULL,
  next_actor TEXT NOT NULL,
  priority TEXT NOT NULL,
  due_text TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  primary_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_resolution TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_precision_events_message_created
  ON precision_classification_events(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS precision_corrections (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  reason_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS precision_correction_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  overrides_json TEXT NOT NULL DEFAULT '{}',
  reason_code TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_precision_correction_events_message_saved
  ON precision_correction_events(message_id, saved_at DESC);

INSERT INTO app_metadata(key, value, updated_at)
VALUES ('storage_contract', 'precision-classification-v1.2.0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
