-- Printer configuration: which printer the kiosk uses (Chrome's default print
-- dialog, or a network ESC/POS printer proxied through core-api over raw TCP).
-- JSONB object { mode, paperWidth, host, port, cutMode }; the default is chrome
-- mode = zero behavior change (the kiosk keeps using Chrome's print dialog).
-- Operational concern (not audited). Idempotent per the migration runner
-- contract (PostgresMigrationRunner applies each file once, checksummed).
ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS printer_configuration JSONB NOT NULL
  DEFAULT '{"mode":"chrome","paperWidth":80,"host":"","port":9100,"cutMode":"partial"}'::jsonb;