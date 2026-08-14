-- Re-queue position policy: a separate WAITING queue ordering key.
--
-- Today the WAITING queue is ordered purely by the IMMUTABLE `created_at`
-- (FIFO), and `QueueTicket.returnToQueue` (the `-> WAITING` side effect in
-- `applyTransition`) keeps `created_at`, so a `CALLING -> WAITING` re-queue
-- snaps a re-queued ticket back to its ORIGINAL near-front FIFO slot. The
-- manager can now declare per-edge what a `-> WAITING` re-queue does to queue
-- order — KEEP (default, backward-compat), TO_BACK, or BACK_N(n) — and the
-- runtime re-stamps a NEW ordering key instead of `created_at`.
--
-- `created_at` cannot be re-stamped: it is the wait-time metric origin
-- (`calledAt - createdAt`, FR-ADM-03) and the archive/receipt position. A new
-- `waiting_order BIGINT` column replaces it as the sort key for every waiting
-- read + `findNextWaiting`; `created_at` keeps its existing role and is never
-- reset. `waiting_order ASC, created_at ASC` (with id as the final tiebreak in
-- the application sort) preserves the exact current FIFO on first deploy:
--
-- 1. ADD COLUMN ... DEFAULT 0 — the column is NOT NULL from the start so every
--    existing row has a value; the default is dropped immediately after the
--    backfill so future inserts MUST supply one (the repo always does).
-- 2. UPDATE tickets SET waiting_order = created_at — backfills every existing
--    row with its `created_at`, so `findNextWaiting` returns the SAME ticket as
--    before deploy (FIFO preserved). Runs ONCE on first apply: the migration
--    runner tracks each migration by SHA-256 and skips an already-applied file,
--    so this UPDATE never re-runs. It is NOT idempotent as a bare statement — a
--    ticket re-queued after first apply has `waiting_order` re-stamped away from
--    `created_at`, so a hypothetical re-run would clobber the re-queue position.
-- 3. DROP DEFAULT — the repo supplies the value on every insert; no implicit
--    default so a future insert bug (omitting the column) fails fast rather
--    than silently ordering a new ticket at the front (0 < every `created_at`).
-- 4. Two indexes: the global `idx_tickets_waiting_order` (waiting_order,
--    created_at) backs `findAllWaiting` + the FIFO_GLOBAL `findNextWaiting`;
--    `idx_tickets_category_waiting_order` (category_id, waiting_order,
--    created_at) backs `findWaitingByCategory` + `findWaitingByCategories` +
--    the BACK_N category-rank read.
--
-- `archived_tickets` gets NO column (the archive move uses an explicit column
-- list → unaffected; reports order by `created_at`). Idempotent per the
-- migration runner's SHA-256 re-apply contract: the schema statements are all
-- `IF NOT EXISTS`, and the backfill UPDATE runs once (see step 2) because the
-- runner skips an already-applied migration.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS waiting_order BIGINT NOT NULL DEFAULT 0;

UPDATE tickets SET waiting_order = created_at;

ALTER TABLE tickets
  ALTER COLUMN waiting_order DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_tickets_waiting_order
  ON tickets (waiting_order, created_at);

CREATE INDEX IF NOT EXISTS idx_tickets_category_waiting_order
  ON tickets (category_id, waiting_order, created_at);