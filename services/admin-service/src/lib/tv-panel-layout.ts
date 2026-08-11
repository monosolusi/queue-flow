import {
  DEFAULT_TV_PANEL_LAYOUT,
  TV_PANEL_KEYS,
  TV_PANEL_SIZE_MAX,
  TV_PANEL_SIZE_MIN,
  type TvPanelConfig,
  type TvPanelKey,
  type TvPanelLayoutMap,
} from '../api/types';

/**
 * Client-side TV-panel-layout validation + pure mutation helpers. The admin
 * `/tv-layout` editor renders one constrained control per panel (segmented
 * size control, visibility checkbox, up/down + drag reorder), so an invalid
 * value is not constructable through the UI — but a direct API prefill (or a
 * corrupt GET) could carry an unknown key or a non-integer. This guard mirrors
 * the UI-reachable subset of the backend `TvPanelLayout` value object
 * (`core-api`'s `domain/store-config/value-objects/tv-panel-layout.ts`): each
 * of the 5 keys present as an object with boolean `visible`, integer `order ≥
 * 0`, and integer `size` in `[1,4]`. The backend VO is permissive on *missing*
 * keys (defaults to the per-key `DEFAULT_TV_PANEL_LAYOUT` entry); this client
 * guard is strict on *presence* because the admin form always sends all 5. The
 * two grammars stay in lock-step for the UI-reachable subset; a divergence is
 * a bug (QUE-34 mirroring rule).
 */

/** The draggable + resizable panel set (runningText is the fixed footer). */
export const CONTENT_PANEL_KEYS: readonly TvPanelKey[] = TV_PANEL_KEYS.filter(
  (k) => k !== 'runningText',
);

/**
 * Friendly Bahasa Indonesia labels for the per-panel `size` value. The wire
 * `value=` stays the integer (1..4); this map is the human label shown in the
 * segmented control. Never sent to the backend (display only). Mirrors the
 * QUE-34 rule: no internal/technical terms in user-visible copy.
 */
export const TV_PANEL_SIZE_LABELS: Record<number, string> = {
  1: 'Kecil',
  2: 'Sedang',
  3: 'Besar',
  4: 'Penuh',
};

/**
 * @returns a list of Indonesian error strings for `map`; empty when valid
 * (mirrors `validateServiceThemes`'s `string[]` contract — empty = valid).
 */
export function validateTvPanelLayout(map: TvPanelLayoutMap): string[] {
  const errors: string[] = [];
  for (const key of TV_PANEL_KEYS) {
    const entry = map[key];
    if (entry === null || typeof entry !== 'object') {
      errors.push(`Panel TV '${key}' harus berupa objek (visible, order, size).`);
      continue;
    }
    if (typeof entry.visible !== 'boolean') {
      errors.push(`Panel TV '${key}.visible' harus boolean (benar/salah).`);
    }
    if (!Number.isInteger(entry.order) || entry.order < 0) {
      errors.push(`Panel TV '${key}.order' harus bilangan bulat tidak negatif.`);
    }
    if (
      !Number.isInteger(entry.size) ||
      entry.size < TV_PANEL_SIZE_MIN ||
      entry.size > TV_PANEL_SIZE_MAX
    ) {
      errors.push(
        `Panel TV '${key}.size' harus bilangan bulat antara ${TV_PANEL_SIZE_MIN} dan ${TV_PANEL_SIZE_MAX}.`,
      );
    }
  }
  return errors;
}

/** True when `map` has a valid {@link TvPanelConfig} for every panel key. */
export function isValidTvPanelLayout(map: TvPanelLayoutMap): boolean {
  return validateTvPanelLayout(map).length === 0;
}

/**
 * Coerces an untrusted/partial `tvPanelLayout` from a GET projection into a
 * complete {@link TvPanelLayoutMap}, defaulting an unknown/missing key to its
 * entry in {@link DEFAULT_TV_PANEL_LAYOUT} (permissive reconstitution, mirrors
 * the backend VO). Used at prefill so the form always carries a complete
 * 5-key map even if the server returned a degraded shape.
 */
export function coerceTvPanelLayout(
  raw: Partial<Record<TvPanelKey, Partial<TvPanelConfig>>> | undefined | null,
): TvPanelLayoutMap {
  if (!raw) return cloneDefault();
  const out = cloneDefault();
  for (const key of TV_PANEL_KEYS) {
    const v = raw[key];
    if (!v || typeof v !== 'object') continue;
    if (typeof v.visible === 'boolean') out[key].visible = v.visible;
    const order = v.order;
    if (typeof order === 'number' && Number.isInteger(order) && order >= 0) {
      out[key].order = order;
    }
    const size = v.size;
    if (
      typeof size === 'number' &&
      Number.isInteger(size) &&
      size >= TV_PANEL_SIZE_MIN &&
      size <= TV_PANEL_SIZE_MAX
    ) {
      out[key].size = size;
    }
  }
  return out;
}

/**
 * Reorders the 4 CONTENT panels (runningText excluded) and reassigns `order`
 * 0..3 by the new position; `runningText.order` stays 4. Returns a new map
 * (the input is not mutated). The pure tested core of the drag/up-down UI.
 *
 * `fromIndex`/`toIndex` are positions in the content-panel order (0..3), NOT
 * `order` values — i.e. they index the list of content panels sorted by their
 * current `order`. A drag moves the panel at `fromIndex` to `toIndex`,
 * shifting the panels between them. Out-of-range indices are clamped.
 */
export function reorderPanels(
  layout: TvPanelLayoutMap,
  fromIndex: number,
  toIndex: number,
): TvPanelLayoutMap {
  const contentKeys = [...CONTENT_PANEL_KEYS].sort(
    (a, b) => layout[a].order - layout[b].order,
  );
  const clampedFrom = clamp(fromIndex, 0, contentKeys.length - 1);
  const clampedTo = clamp(toIndex, 0, contentKeys.length - 1);
  if (clampedFrom === clampedTo) return clone(layout);
  // Move the panel at clampedFrom to clampedTo (a splice-style reorder).
  const [moved] = contentKeys.splice(clampedFrom, 1);
  contentKeys.splice(clampedTo, 0, moved);
  const out = clone(layout);
  contentKeys.forEach((key, i) => {
    out[key].order = i;
  });
  out.runningText.order = 4;
  return out;
}

/** Returns a new map with `key`'s `size` set (clamped to `[1,4]`). */
export function setPanelSize(
  layout: TvPanelLayoutMap,
  key: TvPanelKey,
  size: number,
): TvPanelLayoutMap {
  const out = clone(layout);
  out[key].size = clamp(size, TV_PANEL_SIZE_MIN, TV_PANEL_SIZE_MAX);
  return out;
}

/** Returns a new map with `key`'s `visible` set. */
export function setPanelVisible(
  layout: TvPanelLayoutMap,
  key: TvPanelKey,
  visible: boolean,
): TvPanelLayoutMap {
  const out = clone(layout);
  out[key].visible = visible;
  return out;
}

// --- internals ---

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Deep-ish clone: a fresh map with a fresh `TvPanelConfig` per key. */
function clone(layout: TvPanelLayoutMap): TvPanelLayoutMap {
  const out = {} as TvPanelLayoutMap;
  for (const key of TV_PANEL_KEYS) {
    out[key] = { ...layout[key] };
  }
  return out;
}

/**
 * Returns a fresh copy of {@link DEFAULT_TV_PANEL_LAYOUT} — a new map with a
 * new `TvPanelConfig` per key, so a caller never mutates the shared default.
 * The panel layout has nested objects, so a one-level `{ ...DEFAULT }` spread
 * is not enough; this deep-ish clone is. Exported so the wizard's
 * `emptyForm()` reuses the same clone the editor's {@link coerceTvPanelLayout}
 * falls back to (one place owns the default-copy shape — DRY).
 */
export function defaultTvPanelLayout(): TvPanelLayoutMap {
  return clone(DEFAULT_TV_PANEL_LAYOUT);
}

// Internal alias kept for the `coerceTvPanelLayout` fallback above — same impl.
function cloneDefault(): TvPanelLayoutMap {
  return defaultTvPanelLayout();
}