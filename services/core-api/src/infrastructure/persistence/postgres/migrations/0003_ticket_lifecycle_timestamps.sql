-- QUE-26 lifecycle timestamps for wait-time / service-time analytics
-- (FR-ADM-03). The default state machine is WAITING → CALLING → SERVING →
-- COMPLETED; to compute avg wait time (WAITING → CALLING) and avg service time
-- (SERVING → COMPLETED) we need the transition timestamps, not just
-- created_at / updated_at (the latter only tracks the *latest* transition).
-- The aggregate sets called_at on markCalling/recall, served_at on
-- startServing, completed_at on complete; transfer clears all three (fresh
-- lifecycle under the new category). All nullable: a ticket that never
-- reached a transition has NULL, and the analytics query FILTERs NULLs out.
-- Added to BOTH tickets and archived_tickets (the archive keeps the same
-- shape, so a past-day report reads the same columns).
-- `ADD COLUMN IF NOT EXISTS` keeps this idempotent against the migration
-- runner's SHA-256 re-apply guard.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS called_at    BIGINT,
  ADD COLUMN IF NOT EXISTS served_at    BIGINT,
  ADD COLUMN IF NOT EXISTS completed_at BIGINT;

ALTER TABLE archived_tickets
  ADD COLUMN IF NOT EXISTS called_at    BIGINT,
  ADD COLUMN IF NOT EXISTS served_at    BIGINT,
  ADD COLUMN IF NOT EXISTS completed_at BIGINT;