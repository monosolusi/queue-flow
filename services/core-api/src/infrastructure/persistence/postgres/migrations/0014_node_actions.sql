-- Node actions: per-state Kaleo-style actions for the admin state-machine editor.
-- JSONB keyed map "stateName" -> NodeActionProps[] ({ executionType, type, value }).
-- Empty default '{}' = no node-level actions. Appearance/config concern (not audited).
-- Idempotent per the migration runner contract (PostgresMigrationRunner applies each file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS node_actions JSONB NOT NULL DEFAULT '{}'::jsonb;