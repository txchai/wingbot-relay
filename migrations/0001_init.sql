-- Wingbot schema v1. All times are unix seconds; duration_ms is milliseconds.

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  pair             TEXT NOT NULL,
  from_bot         TEXT NOT NULL,
  to_bot           TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('task', 'result')),
  reply_to         TEXT,
  body_sha256      TEXT NOT NULL,
  size             INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_status_code INTEGER,
  -- Retained only for redelivery; purged 7 days after terminal status.
  envelope_json    TEXT NOT NULL
);

-- Retry sweep: status='queued' AND next_attempt_at <= now.
CREATE INDEX messages_status_next_attempt ON messages (status, next_attempt_at);
-- Purge: terminal status AND updated_at < cutoff.
CREATE INDEX messages_status_updated ON messages (status, updated_at);

CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL,
  attempt     INTEGER NOT NULL,
  http_status INTEGER,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);

CREATE INDEX attempts_message_id ON attempts (message_id);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  event       TEXT NOT NULL,
  message_id  TEXT,
  from_bot    TEXT,
  to_bot      TEXT,
  kind        TEXT CHECK (kind IS NULL OR kind IN ('task', 'result')),
  body_sha256 TEXT,
  -- Short reason code only; never secrets or bodies.
  detail      TEXT
);

CREATE INDEX audit_at ON audit (at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bot          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bot, window_start)
) WITHOUT ROWID;
