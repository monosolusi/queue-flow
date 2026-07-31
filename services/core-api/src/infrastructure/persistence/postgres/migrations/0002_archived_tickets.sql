-- QUE-16 archive store for prior-day tickets relocated during a daily reset
-- (FR-WZD-05). Same shape as `tickets`; rows are moved here atomically by
-- `PostgresQueueRepository.archiveTicketsBefore` inside the reset transaction
-- when `DailyResetPolicy.archivePreviousDayData` is enabled. KEPT separate from
-- the Reporting read models (DailyQueueReport / IReportQueryPort), which are
-- QUE-26 — this table is a raw retention store QUE-26 may build read models over.

CREATE TABLE IF NOT EXISTS archived_tickets (
  id            TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL,
  category_id   TEXT NOT NULL,
  status        TEXT NOT NULL,
  counter_id    INTEGER,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archived_tickets_created_at ON archived_tickets (created_at);
CREATE INDEX IF NOT EXISTS idx_archived_tickets_category_created ON archived_tickets (category_id, created_at);