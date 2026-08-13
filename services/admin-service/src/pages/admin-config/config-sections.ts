/**
 * The config-section identifiers for the operational config panel
 * (FR-ADM-01). Each section is now a real route under `/config/*` (the
 * in-content `ConfigSectionNav` tablist was consolidated into the sidebar), so
 * `SectionId` is the route→section bridge `AdminPanel` consumes as its `section`
 * prop. The `state-machine` section is NOT here — it is the dedicated
 * `/config/alur-status` route (`AlurStatusDesigner`), not an `AdminPanel`
 * section. `AdminPanel` renders exactly one section per route; the shared draft
 * (owned by `ConfigDraftProvider`, the `/config` route element) persists across
 * the routes so a cross-section edit rides ONE full-payload save.
 *
 * The TV-display settings no longer live here — they moved to the dedicated
 * `/tv-layout` page (a 12-column grid editor with a component palette). The
 * `tvPanelLayout` field is carried as a payload-only passthrough on the full
 * PUT so the config save never drops it.
 *
 * Labels + icons + routes live in `components/nav-config.tsx` now (the sidebar
 * owns the IA); this module carries only the id union the panel + its tests
 * key off.
 */
export type SectionId = 'profile' | 'categories' | 'routing' | 'daily-reset' | 'manual';