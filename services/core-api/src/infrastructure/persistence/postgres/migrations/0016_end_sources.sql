-- End sources: explicit "end sources" for the admin state-machine editor — the flat array of
-- state NAMES the manager dragged an explicit arrow from into the End terminal marker (__end).
-- JSONB string[] (flat array, NOT a state-name-keyed map like node_positions/node_actions).
-- Default '[]' = no explicit end sources (the End marker falls back to the auto-derived sink
-- behavior). Purely visual canvas metadata (like node_positions); not audited (appearance concern).
-- State-membership cross-check (every entry ⊆ the active state schema states) runs in the save
-- use case pre-transaction (the VO stays free of a StateMachine dependency — DIP).
-- Idempotent per the migration runner contract.
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS end_sources JSONB NOT NULL DEFAULT '[]'::jsonb;