-- QUE-47: per-service light/dark theme preference on SystemConfiguration.
-- JSONB map (the daily_reset_policy nested-VO precedent, not the scalar
-- brand_color column) keyed by service surface {kiosk,tv,caller,admin} with a
-- 'light'|'dark' value. All-light default matches ServiceThemes.DEFAULT and
-- the CSS :root light default, so an existing store keeps the light look after
-- the column is backfilled (zero visual regression) and a clean store prefills
-- the wizard/admin theme selects with 'light'. Idempotent per the migration
-- runner contract (PostgresMigrationRunner applies each file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS service_themes JSONB NOT NULL DEFAULT '{"kiosk":"light","tv":"light","caller":"light","admin":"light"}';