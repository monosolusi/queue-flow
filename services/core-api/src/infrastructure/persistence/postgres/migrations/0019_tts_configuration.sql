-- Announcement delivery: how fast the TV board reads a called ticket and how
-- much silence separates the parts of the sentence. JSONB object
-- { speed, volume, pauseMs }; the default is speed 1.0, volume 1.0, pauseMs 0 =
-- zero behavior change (one continuous utterance, exactly what the board said
-- before this column existed).
--
-- This is the producer half of a contract that already had a consumer:
-- tts-service polls GET /api/system/config for a top-level `ttsConfiguration`
-- and, finding none, ran on its own hardcoded fallback. The default below is
-- that same fallback, so applying this migration changes nothing audible.
--
-- `engine` and `voice` are deliberately absent — tts-service defaults both when
-- they are missing, and no admin surface selects them yet. Adding them later
-- needs no migration: they are sub-keys inside this JSONB document (the
-- baudRate-after-0013 precedent).
--
-- Operational concern (not audited). Idempotent per the migration runner
-- contract (PostgresMigrationRunner applies each file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS tts_configuration JSONB NOT NULL
  DEFAULT '{"speed":1,"volume":1,"pauseMs":0}'::jsonb;
