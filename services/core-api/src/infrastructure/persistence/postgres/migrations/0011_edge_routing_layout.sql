-- Edge routing layout: per-edge connection-point (handle) choice for the admin
-- state-machine visual editor. JSONB keyed map "from->to" ->
-- { sourceSide, targetSide } (each 'top'|'right'|'bottom'|'left'). Sparse: only
-- non-default entries are stored; empty default '{}' means every edge uses the
-- default left->right routing. Appearance concern (not audited). Idempotent per
-- the migration runner contract (PostgresMigrationRunner applies each file
-- once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS edge_routing_layout JSONB NOT NULL DEFAULT '{}'::jsonb;