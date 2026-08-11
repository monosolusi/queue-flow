-- TV display options — per-panel visibility toggles (JSONB map on
-- system_configuration). All-true default preserves the existing TV layout
-- (every panel visible) so an existing store keeps its look after the column
-- is backfilled (zero visual regression) and a clean store defaults to every
-- panel shown. Mirrors the service_themes JSONB precedent (0007). Idempotent
-- per the migration runner contract (PostgresMigrationRunner applies each
-- file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS tv_display_options JSONB NOT NULL
  DEFAULT '{"showNowServing":true,"showWaitingQueue":true,"showCallHistory":true,"showCountersServing":true,"showRunningText":true}';