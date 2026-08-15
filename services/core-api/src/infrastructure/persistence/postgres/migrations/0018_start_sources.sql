-- Start sources: explicit "start sources" for the admin state-machine editor — the flat array of
-- state NAMES the manager dragged an explicit arrow from the Start terminal marker (__start) to.
-- JSONB string[] (flat array, NOT a state-name-keyed map like node_positions/node_actions).
-- Default '[]' = no explicit start sources (the Start marker falls back to the auto-derived source
-- behavior). Purely visual canvas metadata (like node_positions/end_sources); not audited (appearance concern).
-- State-membership cross-check (every entry ⊆ the active state schema states) runs in the save
-- use case pre-transaction (the VO stays free of a StateMachine dependency — DIP).
-- Idempotent per the migration runner contract.
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS start_sources JSONB NOT NULL DEFAULT '[]'::jsonb;