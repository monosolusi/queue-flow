-- Terminal nodes: persisted Start/End marker presence + position for the admin state-machine editor.
-- JSONB { start, end } each 'auto' | 'hidden' | { x, y }. Default auto/auto (derive from topology).
-- Appearance concern (not audited). Idempotent per the migration runner contract.
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS terminal_nodes JSONB NOT NULL DEFAULT '{"start":"auto","end":"auto"}'::jsonb;