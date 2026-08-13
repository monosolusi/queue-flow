-- Node positions: per-state x/y position for the admin state-machine visual
-- editor. JSONB keyed map "stateName" -> { x, y }. Non-sparse: every state whose
-- position is known has an entry; empty default '{}' means use the deterministic
-- autoLayout. Appearance concern (not audited). Idempotent per the migration
-- runner contract (PostgresMigrationRunner applies each file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS node_positions JSONB NOT NULL DEFAULT '{}'::jsonb;