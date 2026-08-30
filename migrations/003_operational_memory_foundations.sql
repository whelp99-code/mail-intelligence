ALTER TABLE message_feedback RENAME TO message_feedback_v1_legacy;

CREATE TABLE message_feedback (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_status TEXT NOT NULL CHECK (user_status IN ('urgent', 'active', 'waiting', 'done', 'reference')),
  reason_code TEXT NOT NULL DEFAULT '',
  reason_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  sender_snapshot TEXT NOT NULL DEFAULT '',
  subject_snapshot TEXT NOT NULL DEFAULT '',
  subject_tokens_json TEXT NOT NULL DEFAULT '[]',
  saved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO message_feedback(
  message_id, user_status, reason_code, reason_label, note,
  sender_snapshot, subject_snapshot, subject_tokens_json, saved_at, updated_at
)
SELECT
  message_id, user_status, reason_code, reason_label, note,
  sender_snapshot, subject_snapshot, subject_tokens_json, saved_at, updated_at
FROM message_feedback_v1_legacy;

DROP TABLE message_feedback_v1_legacy;

DROP INDEX IF EXISTS idx_feedback_events_message_saved;
ALTER TABLE feedback_events RENAME TO feedback_events_v1_legacy;

CREATE TABLE feedback_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_status TEXT NOT NULL CHECK (user_status IN ('urgent', 'active', 'waiting', 'done', 'reference')),
  reason_code TEXT NOT NULL DEFAULT '',
  reason_label TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  saved_at TEXT NOT NULL
) STRICT;

INSERT INTO feedback_events(
  id, message_id, user_status, reason_code, reason_label, note, saved_at
)
SELECT id, message_id, user_status, reason_code, reason_label, note, saved_at
FROM feedback_events_v1_legacy;

DROP TABLE feedback_events_v1_legacy;

CREATE INDEX idx_feedback_events_message_saved
  ON feedback_events(message_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  observation_type TEXT NOT NULL,
  value_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'rules',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (review_status IN ('candidate', 'accepted', 'rejected', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_observations_message_type
  ON observations(message_id, observation_type, updated_at DESC);

CREATE TABLE IF NOT EXISTS operator_jobs (
  id INTEGER PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL
    CHECK (job_type IN ('mail-sync', 'legacy-import', 'integrity-check', 'backup', 'restore')),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead-letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_operator_jobs_status_updated
  ON operator_jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS dead_letter_events (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES operator_jobs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_dead_letter_events_open
  ON dead_letter_events(resolved_at, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_items (
  id INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'pending-approval', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  approval_id TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_outbox_items_status_updated
  ON outbox_items(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS backup_manifests (
  id INTEGER PRIMARY KEY,
  backup_name TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  record_counts_json TEXT NOT NULL DEFAULT '{}',
  integrity_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
) STRICT;

INSERT INTO app_metadata(key, value, updated_at)
VALUES ('storage_contract', 'persistent-mail-memory-v1.1.0', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
