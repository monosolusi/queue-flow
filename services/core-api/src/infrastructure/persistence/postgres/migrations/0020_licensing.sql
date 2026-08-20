-- Licensing (Licensing bounded context).
--
-- Two tables, and the split between them is deliberate:
--
--   `installation` is the identity and runtime state of THIS deployment. It is
--   a singleton, created on first boot, and it is what every license is issued
--   against. Because it lives in the database it travels with a backup restore
--   and survives an upgrade -- a customer who replaces a failed mini PC and
--   restores keeps working. That same portability is why host fingerprinting
--   exists: copying the pgdata volume copies this row too.
--
--   `licenses` is append-only history. Which license was active when is exactly
--   the question a billing dispute asks, and there is no server-side record to
--   fall back on -- an offline product has no license server to query. Rows are
--   deactivated, never deleted or overwritten.
--
-- Idempotent per the migration runner contract (PostgresMigrationRunner applies
-- each file once, checksummed).

CREATE TABLE IF NOT EXISTS installation (
  id                  TEXT PRIMARY KEY,
  installation_id     TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  -- Monotonic high-water mark of observed time. An offline box has no NTP, so
  -- its wall clock is the customer's to set; expiry is evaluated against
  -- max(now, last_seen_at) so winding the clock back cannot revive a lapsed
  -- trial. Only ever moves forward.
  last_seen_at        TIMESTAMPTZ NOT NULL,
  -- When a host mismatch was FIRST observed, or NULL while the host matches.
  -- The mismatch grace window is anchored here because a license cannot know
  -- when the hardware changed -- only the installation can observe it.
  host_mismatch_since TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS licenses (
  id           TEXT PRIMARY KEY,
  -- The armored token exactly as uploaded. Stored verbatim, never re-encoded:
  -- the signature covers specific bytes, and normalising them on the way in
  -- would invalidate a license that was perfectly good.
  token        TEXT        NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL,
  -- Authenticated principal's username (NFR-SEC-02), or the 'system' sentinel
  -- on the pre-setup activation path where no principal exists yet.
  installed_by TEXT        NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE
);

-- At most one active license. A partial unique index rather than application
-- logic: activation deactivates the previous row and inserts the new one in one
-- transaction, and this makes a torn write impossible to commit rather than
-- merely unlikely (NFR-REL-02).
CREATE UNIQUE INDEX IF NOT EXISTS licenses_single_active
  ON licenses ((TRUE)) WHERE is_active;
