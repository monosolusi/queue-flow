import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * Component types a manager can place on the TV grid. Stable wire identifier;
 * friendly Bahasa Indonesia labels live in the admin client, never here.
 */
export type TvComponentType =
  | 'nowServing'
  | 'waitingQueue'
  | 'callHistory'
  | 'countersServing'
  | 'runningText';

/** One placed widget on the 12-column TV grid. */
export interface TvWidget {
  readonly id: string; // stable unique instance id (UUID v4 on create; component type as id in the default)
  readonly component: TvComponentType;
  readonly x: number; // column start, 0-based, 0..GRID_COLS-1
  readonly y: number; // row start, 0-based, >=0
  readonly w: number; // column span, 1..GRID_COLS, x+w <= GRID_COLS
  readonly h: number; // row span, 1..GRID_MAX_ROWS, y+h <= GRID_MAX_ROWS
}

/** Persisted TV layout: an ordered list of placed widgets (empty array = no panels → idle board). */
export type TvGridLayout = readonly TvWidget[];

export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 20;
export const GRID_MIN_W = 1;
export const GRID_MIN_H = 1;

export const TV_COMPONENT_TYPES: readonly TvComponentType[] = [
  'nowServing',
  'waitingQueue',
  'callHistory',
  'countersServing',
  'runningText',
];

/**
 * PRD-default grid layout (mirrors the previous default's visual: hero on top,
 * waiting+history side by side, counters full width, running text footer — zero
 * visual regression). Widget id = component type in the default (one instance
 * each); palette drops mint a fresh UUID.
 */
export const DEFAULT_TV_GRID_LAYOUT: TvGridLayout = [
  { id: 'nowServing', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
  { id: 'waitingQueue', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
  { id: 'callHistory', component: 'callHistory', x: 6, y: 4, w: 6, h: 3 },
  { id: 'countersServing', component: 'countersServing', x: 0, y: 7, w: 12, h: 3 },
  { id: 'runningText', component: 'runningText', x: 0, y: 10, w: 12, h: 1 },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Axis-aligned rectangle overlap test. A widget occupies columns
 * `[x, x+w)` and rows `[y, y+h)`; two widgets overlap iff their column spans
 * and row spans both intersect (strictly — touching edges do NOT overlap).
 */
function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const aCols = [a.x, a.x + a.w];
  const aRows = [a.y, a.y + a.h];
  const bCols = [b.x, b.x + b.w];
  const bRows = [b.y, b.y + b.h];
  // Strict `<` (not `<=`) so edge-adjacent widgets (e.g. one ends at col 6,
  // the next starts at col 6) do NOT overlap.
  return aCols[0] < bCols[1] && bCols[0] < aCols[1] && aRows[0] < bRows[1] && bRows[0] < aRows[1];
}

/**
 * Per-widget TV layout (a 12-column grid of placed widgets), persisted on
 * {@link SystemConfiguration} as a JSONB array column (the
 * `service_themes` / `daily_reset_policy` nested-VO precedent, not the scalar
 * `brand_color` column — a widget list is a nested value object). The TV
 * fetches `GET /api/system/config` at boot, reads the array, and renders each
 * placed widget at its `(x, y, w, h)` grid cell (all-five-widgets at the
 * PRD-default positions is the default, so a store that never configures this
 * keeps the existing TV layout — zero visual regression, mirroring
 * `ServiceThemes`).
 *
 * `of()` is permissive on *missing* (a `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a reconstituted row from
 * before this column existed, or a defensively-empty column, recovers to the
 * default layout without a migration. It is strict only on *present* widgets:
 * a non-array raw, a non-object element, or a present field with the wrong
 * type / out-of-range value / duplicate id / overlapping rectangle throws
 * `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails fast
 * (NFR-REL-02 — no illegal layout burns a write).
 *
 * The overlap invariant is the grid's structural correctness rule: no two
 * widgets' axis-aligned rectangles may share a cell. Edge-adjacent widgets
 * (one ends at column 6, the next starts at column 6) do NOT overlap — the
 * spans are half-open `[x, x+w)`. An empty array is valid (an empty board →
 * the idle state); the manager cleared every panel intentionally.
 *
 * Not change-gated for audit — `tvPanelLayout` is an appearance concern, like
 * `brandColor`/`serviceThemes`, and is not in the NFR-SEC-02 audited list
 * (manual reset, state-schema, routing). `equals` is inherited (structural
 * deep-equal, order-sensitive over the widget array) and available if a
 * future ticket adds layout-change diff-audit.
 */
export class TvPanelLayout extends ValueObject<TvGridLayout> {
  private constructor(widgets: TvGridLayout) {
    super(widgets);
  }

  public static of(raw: unknown): TvPanelLayout {
    // Non-array (undefined/null from the pre-migration boot window or a JSON
    // null) → default layout. A present-but-wrong-shape value (string, plain
    // object, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return TvPanelLayout.DEFAULT;
    }
    if (!Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `tv panel layout must be an array of widgets, got '${String(raw)}'`,
      );
    }
    const widgets: TvWidget[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const element = raw[i];
      if (!isPlainObject(element)) {
        throw new InvalidValueObjectException(
          `tv panel layout[${i}] must be a plain object, got '${String(element)}'`,
        );
      }
      const e = element as Record<string, unknown>;
      // `id` — stable unique instance id, non-empty string.
      const id = e.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new InvalidValueObjectException(
          `tv panel layout[${i}].id must be a non-empty string, got '${String(id)}'`,
        );
      }
      if (seenIds.has(id)) {
        throw new InvalidValueObjectException(
          `tv widget '${id}' has a duplicate id`,
        );
      }
      seenIds.add(id);
      // `component` — must be one of the stable wire identifiers.
      const component = e.component;
      if (
        typeof component !== 'string' ||
        !(TV_COMPONENT_TYPES as readonly string[]).includes(component)
      ) {
        throw new InvalidValueObjectException(
          `tv widget '${id}' component must be one of [${TV_COMPONENT_TYPES.join(', ')}], got '${String(component)}'`,
        );
      }
      // `x` — column start, 0-based, 0..GRID_COLS-1.
      const x = e.x;
      if (!isInteger(x) || x < 0 || x > GRID_COLS - 1) {
        throw new InvalidValueObjectException(
          `tv widget '${id}'.x must be an integer in [0, ${GRID_COLS - 1}], got '${String(x)}'`,
        );
      }
      // `y` — row start, 0-based, >=0 and < GRID_MAX_ROWS (a widget must start
      // within the grid; its span may reach the max row).
      const y = e.y;
      if (!isInteger(y) || y < 0 || y > GRID_MAX_ROWS - 1) {
        throw new InvalidValueObjectException(
          `tv widget '${id}'.y must be an integer in [0, ${GRID_MAX_ROWS - 1}], got '${String(y)}'`,
        );
      }
      // `w` — column span, 1..GRID_COLS, x+w <= GRID_COLS.
      const w = e.w;
      if (!isInteger(w) || w < GRID_MIN_W || w > GRID_COLS || x + w > GRID_COLS) {
        throw new InvalidValueObjectException(
          `tv widget '${id}'.w must be an integer in [${GRID_MIN_W}, ${GRID_COLS}] with x+w <= ${GRID_COLS}, got '${String(w)}' (x=${x})`,
        );
      }
      // `h` — row span, 1..GRID_MAX_ROWS, y+h <= GRID_MAX_ROWS.
      const h = e.h;
      if (!isInteger(h) || h < GRID_MIN_H || h > GRID_MAX_ROWS || y + h > GRID_MAX_ROWS) {
        throw new InvalidValueObjectException(
          `tv widget '${id}'.h must be an integer in [${GRID_MIN_H}, ${GRID_MAX_ROWS}] with y+h <= ${GRID_MAX_ROWS}, got '${String(h)}' (y=${y})`,
        );
      }
      // Overlap check against every widget already accepted (O(n^2) over the
      // widget list — n is tiny, ~5 widgets, so no need for a sweep-line).
      const candidate = { x, y, w, h };
      for (const prev of widgets) {
        if (rectsOverlap(candidate, prev)) {
          throw new InvalidValueObjectException(
            `tv widget '${id}' overlaps widget '${prev.id}'`,
          );
        }
      }
      // Deep-copy each widget into the stored array so the caller's input
      // cannot mutate the VO's internal state. Unknown extra properties are
      // ignored — only the 5 canonical fields are read.
      widgets.push({ id, component: component as TvComponentType, x, y, w, h });
    }
    return new TvPanelLayout(widgets);
  }

  /** The PRD-default grid layout — every widget at its default position.
   * Matches `ServiceThemes.DEFAULT` / `BrandColor.DEFAULT` for zero visual
   * regression. */
  public static DEFAULT: TvPanelLayout = TvPanelLayout.of(DEFAULT_TV_GRID_LAYOUT);

  /** The ordered list of placed widgets. */
  public get widgets(): TvGridLayout {
    return this.props;
  }

  /** Returns a deep copy of the widget array so callers can mutate the DTO
   * without affecting the VO (each widget is rebuilt into a fresh object). */
  public toDto(): TvGridLayout {
    return this.props.map((w) => ({
      id: w.id,
      component: w.component,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
    }));
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}