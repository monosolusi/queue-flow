/**
 * The in-content navigation sections of the operational config panel
 * (FR-ADM-01). The panel renders one section at a time — the manager no longer
 * scrolls a single long form. Each section with a save button calls the same
 * full-payload `PUT /api/system/config` save (unchanged sections pass through);
 * the `manual` section has no save button (its two operations are separate
 * POSTs). `SectionId` doubles as the nav-item key and the `role="tab"` id
 * suffix; the nav component derives `aria-controls`/`aria-labelledby` pairs from
 * it. See `ConfigSectionNav.tsx`.
 *
 * The TV-display settings no longer live here — they moved to the dedicated
 * `/tv-layout` page (drag-and-drop reorder + per-panel resize). The
 * `tvPanelLayout` field is carried as a payload-only passthrough on the full
 * PUT so the config save never drops it.
 *
 * Order is the nav display order; the default active section is `profile`
 * (the first entry), so the manager lands on the most-edited section.
 */
export type SectionId =
  | 'profile'
  | 'categories'
  | 'routing'
  | 'daily-reset'
  | 'state-machine'
  | 'manual';

export interface ConfigSection {
  readonly id: SectionId;
  readonly label: string;
}

export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  { id: 'profile', label: 'Profil & Tampilan' },
  { id: 'categories', label: 'Kategori' },
  { id: 'routing', label: 'Counter & Routing' },
  { id: 'daily-reset', label: 'Reset Harian' },
  { id: 'state-machine', label: 'Alur Status Tiket' },
  { id: 'manual', label: 'Operasi Manual' },
] as const;

/** The section the panel opens on. */
export const DEFAULT_SECTION: SectionId = 'profile';