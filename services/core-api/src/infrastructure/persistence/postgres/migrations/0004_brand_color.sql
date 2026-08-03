-- QUE-36 brand color on the singleton system_configuration (PRD §7).
-- `brand_color` is a manager-configurable accent the four frontends derive
-- `--accent` (and brand-tinted neutrals) from at load, so a store's UI carries
-- its own identity instead of the shared default blue. Scalar TEXT (matches
-- store_name's treatment — a single color string, not a JSONB blob): the
-- `BrandColor` value object accepts hex (#rgb | #rrggbb | #rrggbbaa) or
-- oklch(...). The DEFAULT '#2563eb' matches the hardcoded `--accent` across
-- all four frontends, so an existing store that never set a brand color keeps
-- its current look (zero visual regression). `NOT NULL` so reconstitute always
-- has a value. `ADD COLUMN IF NOT EXISTS` keeps this idempotent against the
-- migration runner's SHA-256 re-apply guard; the DEFAULT backfills the existing
-- single row in place.

ALTER TABLE system_configuration
  ADD COLUMN IF NOT EXISTS brand_color TEXT NOT NULL DEFAULT '#2563eb';