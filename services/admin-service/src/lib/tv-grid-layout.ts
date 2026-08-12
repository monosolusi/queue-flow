/**
 * Pure, framework-free helpers for the TV-display 12-column grid layout editor
 * (`/tv-layout`). Mirrors the UI-reachable subset of core-api's `TvGridLayout`
 * value object (`domain/store-config/value-objects/tv-grid-layout.ts`): each
 * widget is a plain object with a non-empty string id, a valid component enum,
 * integer `x ∈ [0, GRID_COLS-1]`, `y ∈ [0, GRID_MAX_ROWS-1]`,
 * `w ∈ [GRID_MIN_W, GRID_COLS]` with `x + w ≤ GRID_COLS`,
 * `h ∈ [GRID_MIN_H, GRID_MAX_ROWS]` with `y + h ≤ GRID_MAX_ROWS`, no duplicate
 * ids, and no two widgets overlap (axis-aligned rect collision on columns
 * [x,x+w) × rows [y,y+h)). The two grammars stay in lock-step for the
 * UI-reachable subset; a divergence is a bug (QUE-34 mirroring rule).
 *
 * The editor's pointer-DnD path (move/resize via `useGridDnd`) and the a11y
 * stepper path both funnel through these immutable helpers, so the tested core
 * is jsdom-runnable (no `getBoundingClientRect` — the pointer hook is a thin
 * browser-only UI layer, mirroring the `use-drag-reorder` precedent).
 */

import {
  DEFAULT_TV_GRID_LAYOUT,
  DEFAULT_WIDGET_SIZE,
  GRID_COLS,
  GRID_MAX_ROWS,
  GRID_MIN_H,
  GRID_MIN_W,
  TV_COMPONENT_TYPES,
  type TvComponentType,
  type TvGridLayout,
  type TvWidget,
} from '../api/types';

// Re-export the geometry constants + component list so the editor + tests have
// one import surface (the wire contract in `api/types.ts` stays the single
// source of truth — these re-exports are aliases, not copies).
export {
  DEFAULT_TV_GRID_LAYOUT,
  DEFAULT_WIDGET_SIZE,
  GRID_COLS,
  GRID_MAX_ROWS,
  GRID_MIN_H,
  GRID_MIN_W,
  TV_COMPONENT_TYPES,
};
export type { TvComponentType, TvGridLayout, TvWidget };

/**
 * Friendly Bahasa Indonesia labels for the TV-display component types. The
 * component key stays as the wire identifier (`nowServing`/`waitingQueue`/…);
 * this map is the display name shown on palette chips + widget headers in the
 * `/tv-layout` editor. Never sent to the backend (display only). Mirrors the
 * QUE-34 rule: no internal/technical terms in user-visible copy — the labels
 * name the panel as the manager sees it on the TV board.
 */
export const TV_COMPONENT_LABELS: Record<TvComponentType, string> = {
  nowServing: 'Sedang Dilayani',
  waitingQueue: 'Antrian Berikutnya',
  callHistory: 'Riwayat Panggilan',
  countersServing: 'Sedang Melayani (per counter)',
  runningText: 'Teks Berjalan',
};

/**
 * @returns a list of Indonesian error strings for `layout`; empty when valid
 *          (mirrors `validateServiceThemes`'s `string[]` contract — empty =
 *          valid). `layout` is typed `unknown` so a corrupt GET projection is
 *          safely rejectable without a thrown exception.
 */
export function validateTvGridLayout(layout: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(layout)) {
    errors.push('Tata letak TV harus berupa daftar komponen.');
    return errors;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < layout.length; i++) {
    const w = layout[i];
    if (w === null || typeof w !== 'object') {
      errors.push(`Komponen TV #${i + 1} harus berupa objek (id, component, x, y, w, h).`);
      continue;
    }
    const widget = w as Record<string, unknown>;
    if (typeof widget.id !== 'string' || widget.id.length === 0) {
      errors.push(`Komponen TV #${i + 1}.id harus string tidak kosong.`);
    } else if (seenIds.has(widget.id)) {
      errors.push(`Komponen TV #${i + 1}.id ganda ("${widget.id}").`);
    } else {
      seenIds.add(widget.id);
    }
    if (
      typeof widget.component !== 'string' ||
      !TV_COMPONENT_TYPES.includes(widget.component as TvComponentType)
    ) {
      errors.push(`Komponen TV #${i + 1}.component tidak dikenal.`);
    }
    if (!Number.isInteger(widget.x) || (widget.x as number) < 0 || (widget.x as number) > GRID_COLS - 1) {
      errors.push(`Komponen TV #${i + 1}.x harus bilangan bulat antara 0 dan ${GRID_COLS - 1}.`);
    }
    if (!Number.isInteger(widget.y) || (widget.y as number) < 0 || (widget.y as number) > GRID_MAX_ROWS - 1) {
      errors.push(`Komponen TV #${i + 1}.y harus bilangan bulat antara 0 dan ${GRID_MAX_ROWS - 1}.`);
    }
    if (!Number.isInteger(widget.w) || (widget.w as number) < GRID_MIN_W || (widget.w as number) > GRID_COLS) {
      errors.push(`Komponen TV #${i + 1}.w harus bilangan bulat antara ${GRID_MIN_W} dan ${GRID_COLS}.`);
    }
    if (!Number.isInteger(widget.h) || (widget.h as number) < GRID_MIN_H || (widget.h as number) > GRID_MAX_ROWS) {
      errors.push(`Komponen TV #${i + 1}.h harus bilangan bulat antara ${GRID_MIN_H} dan ${GRID_MAX_ROWS}.`);
    }
    if (
      Number.isInteger(widget.x) && Number.isInteger(widget.w) &&
      (widget.x as number) + (widget.w as number) > GRID_COLS
    ) {
      errors.push(`Komponen TV #${i + 1}.x + w melebihi ${GRID_COLS} kolom.`);
    }
    if (
      Number.isInteger(widget.y) && Number.isInteger(widget.h) &&
      (widget.y as number) + (widget.h as number) > GRID_MAX_ROWS
    ) {
      errors.push(`Komponen TV #${i + 1}.y + h melebihi ${GRID_MAX_ROWS} baris.`);
    }
  }
  // Overlap check only when all individual widgets are well-formed (otherwise
  // the rect math is meaningless).
  if (errors.length === 0 && hasInternalOverlap(layout as TvWidget[])) {
    errors.push('Tata letak TV memiliki komponen yang saling tumpang tindih.');
  }
  return errors;
}

/** True when `layout` is a valid {@link TvGridLayout} (no errors). */
export function isValidTvGridLayout(layout: unknown): boolean {
  return validateTvGridLayout(layout).length === 0;
}

/**
 * Coerces an untrusted/partial `tvPanelLayout` from a GET projection into a
 * valid {@link TvGridLayout}. If `raw` is already a valid array of valid
 * widgets (no dup id, no overlap), returns a deep copy; otherwise falls back
 * to {@link defaultTvGridLayout}. Used at prefill so the form always carries a
 * valid array even if the server returned a degraded shape.
 */
export function coerceTvGridLayout(raw: unknown): TvGridLayout {
  if (isValidTvGridLayout(raw)) {
    return (raw as TvWidget[]).map((w) => ({ ...w }));
  }
  return defaultTvGridLayout();
}

/**
 * Returns a fresh deep copy of {@link DEFAULT_TV_GRID_LAYOUT} — new widget
 * objects, so a caller never mutates the shared default. The layout is an
 * array of plain objects, so a one-level `.map(w => ({ ...w }))` is enough.
 * Exported so the wizard's `emptyForm()` reuses the same clone the editor's
 * {@link coerceTvGridLayout} falls back to (one place owns the default-copy
 * shape — DRY).
 */
export function defaultTvGridLayout(): TvGridLayout {
  return DEFAULT_TV_GRID_LAYOUT.map((w) => ({ ...w }));
}

/**
 * Returns a fresh UUID v4 for a new widget. `crypto.randomUUID` is available
 * in the browser (admin-service is a PWA, served over localhost/LAN — a secure
 * context). Used on palette drop / click-add.
 */
export function newWidgetId(): string {
  return crypto.randomUUID();
}

/**
 * Axis-aligned rect overlap (columns [x, x+w), rows [y, y+h)). True when the
 * two rects share at least one cell.
 */
export function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

/**
 * True when a candidate `widget` rect would overlap any widget in `layout`
 * other than the one with id `exceptId` (the moving/resizing widget itself).
 */
export function hasOverlap(
  layout: TvGridLayout,
  widget: { x: number; y: number; w: number; h: number },
  exceptId?: string,
): boolean {
  for (const other of layout) {
    if (exceptId !== undefined && other.id === exceptId) continue;
    if (rectsOverlap(widget, other)) return true;
  }
  return false;
}

/**
 * Scans the grid row-by-row, left-to-right, for the first position where a
 * `w × h` widget fits without overlap. Returns `{ x, y }` or `null` if none
 * within `GRID_MAX_ROWS`. Used by click-to-add (the a11y add path).
 */
export function findFreeSpot(
  layout: TvGridLayout,
  w: number,
  h: number,
): { x: number; y: number } | null {
  const cw = clamp(w, GRID_MIN_W, GRID_COLS);
  const ch = clamp(h, GRID_MIN_H, GRID_MAX_ROWS);
  for (let y = 0; y <= GRID_MAX_ROWS - ch; y++) {
    for (let x = 0; x <= GRID_COLS - cw; x++) {
      if (!hasOverlap(layout, { x, y, w: cw, h: ch })) {
        return { x, y };
      }
    }
  }
  return null;
}

/**
 * Creates a widget of `component` type with a fresh id, sized per
 * {@link DEFAULT_WIDGET_SIZE}, at `(opts.x, opts.y)` if given AND non-
 * overlapping; otherwise placed at {@link findFreeSpot} for the default size;
 * if no spot, returns `null`. On success returns the new array (immutably) +
 * the new id.
 */
export function addWidget(
  layout: TvGridLayout,
  component: TvComponentType,
  opts?: { x?: number; y?: number },
): { layout: TvGridLayout; id: string } | null {
  const size = DEFAULT_WIDGET_SIZE[component];
  const id = newWidgetId();
  let x: number | undefined;
  let y: number | undefined;
  if (opts && typeof opts.x === 'number' && typeof opts.y === 'number') {
    x = clamp(opts.x, 0, GRID_COLS - size.w);
    y = clamp(opts.y, 0, GRID_MAX_ROWS - size.h);
    if (hasOverlap(layout, { x, y, w: size.w, h: size.h })) {
      // Explicit spot is blocked — fall through to free-spot search.
      x = undefined;
      y = undefined;
    }
  }
  if (x === undefined || y === undefined) {
    const spot = findFreeSpot(layout, size.w, size.h);
    if (spot === null) return null;
    x = spot.x;
    y = spot.y;
  }
  const widget: TvWidget = { id, component, x, y, w: size.w, h: size.h };
  return { layout: [...layout, widget], id };
}

/**
 * Sets the widget's `x`/`y` (clamped in-bounds: `x ∈ [0, GRID_COLS - w]`,
 * `y ∈ [0, GRID_MAX_ROWS - h]`). If the new rect overlaps another widget,
 * returns the ORIGINAL layout unchanged (caller detects the no-op via
 * reference equality). Immutable.
 */
export function moveWidget(layout: TvGridLayout, id: string, x: number, y: number): TvGridLayout {
  const idx = layout.findIndex((w) => w.id === id);
  if (idx === -1) return layout;
  const w = layout[idx];
  const nx = clamp(x, 0, GRID_COLS - w.w);
  const ny = clamp(y, 0, GRID_MAX_ROWS - w.h);
  if (nx === w.x && ny === w.y) return layout;
  if (hasOverlap(layout, { x: nx, y: ny, w: w.w, h: w.h }, id)) return layout;
  return layout.map((other, i) => (i === idx ? { ...other, x: nx, y: ny } : other));
}

/**
 * Sets the widget's `w`/`h` (clamped so `x + w ≤ GRID_COLS` and
 * `y + h ≤ GRID_MAX_ROWS`). If the new rect overlaps another widget, returns
 * the ORIGINAL layout unchanged. Immutable.
 */
export function resizeWidget(layout: TvGridLayout, id: string, w: number, h: number): TvGridLayout {
  const idx = layout.findIndex((wgt) => wgt.id === id);
  if (idx === -1) return layout;
  const cur = layout[idx];
  const nw = clamp(w, GRID_MIN_W, GRID_COLS - cur.x);
  const nh = clamp(h, GRID_MIN_H, GRID_MAX_ROWS - cur.y);
  if (nw === cur.w && nh === cur.h) return layout;
  if (hasOverlap(layout, { x: cur.x, y: cur.y, w: nw, h: nh }, id)) return layout;
  return layout.map((other, i) => (i === idx ? { ...other, w: nw, h: nh } : other));
}

/** Returns a new layout with the widget `id` removed. Returns the ORIGINAL
 * array (ref-equal) when `id` is not present (a no-op), matching the
 * `moveWidget`/`resizeWidget` no-op contract. Immutable otherwise. */
export function removeWidget(layout: TvGridLayout, id: string): TvGridLayout {
  if (!layout.some((w) => w.id === id)) return layout;
  return layout.filter((w) => w.id !== id);
}

// --- internals ---

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** True when any two widgets in `layout` overlap (assumes all are well-formed
 *  — only call after individual validation passes). */
function hasInternalOverlap(layout: TvGridLayout): boolean {
  for (let i = 0; i < layout.length; i++) {
    for (let j = i + 1; j < layout.length; j++) {
      if (rectsOverlap(layout[i], layout[j])) return true;
    }
  }
  return false;
}