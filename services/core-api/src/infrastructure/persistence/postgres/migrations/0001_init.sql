-- QUE-30 initial schema. Single-host on-premise QMS (PRD §4 / NFR-REL-02).
-- Default WAL (fsync=on, synchronous_commit=on) gives crash durability — no
-- duplicate/lost ticket numbers after a power cut.

CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counter_routing_rules (
  id                   TEXT PRIMARY KEY,
  counter_id           INTEGER NOT NULL UNIQUE,
  counter_name         TEXT NOT NULL,
  assigned_category_ids TEXT[] NOT NULL,
  priority_policy       TEXT NOT NULL
);

-- Singleton row: the single SystemConfiguration aggregate.
CREATE TABLE IF NOT EXISTS system_configuration (
  id                        TEXT PRIMARY KEY,
  store_name                TEXT NOT NULL,
  is_initial_setup_completed BOOLEAN NOT NULL DEFAULT FALSE,
  state_machine              JSONB NOT NULL,
  daily_reset_policy        JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_counters (
  category_id TEXT NOT NULL,
  date        TEXT NOT NULL,
  value       INTEGER NOT NULL,
  PRIMARY KEY (category_id, date)
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL,
  category_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  counter_id    INTEGER,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_status_category ON tickets (status, category_id);
CREATE INDEX IF NOT EXISTS idx_tickets_counter_status ON tickets (counter_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_category_created ON tickets (category_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  before      TEXT,
  after       TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);