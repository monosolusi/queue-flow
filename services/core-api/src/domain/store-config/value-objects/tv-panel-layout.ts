import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The five TV-display panels a manager can show/hide, reorder, and resize. The
 * keys are stable wire identifiers — the friendly display names live in the
 * admin client (`TV_PANEL_LABELS`), never here.
 *
 * `runningText` is a fixed marquee footer: its `order`/`size` are stored for
 * map uniformity (one shape across all panels) but **ignored by the TV** — it
 * is always rendered last as a footer. The admin editor exposes only a
 * visibility toggle for it (no drag handle / no size control).
 */
export type TvPanelKey =
  | 'nowServing'
  | 'waitingQueue'
  | 'callHistory'
  | 'countersServing'
  | 'runningText';

/** Per-panel layout config: visibility, render order, and relative size. */
export interface TvPanelConfig {
  visible: boolean;
  /** Non-negative integer render order (ascending = top-to-bottom). */
  order: number;
  /** Relative size weight (integer in `[TV_PANEL_SIZE_MIN..TV_PANEL_SIZE_MAX]`). */
  size: number;
}

/** The persisted shape: one {@link TvPanelConfig} per {@link TvPanelKey}. */
export type TvPanelLayoutMap = Record<TvPanelKey, TvPanelConfig>;

export const TV_PANEL_KEYS: readonly TvPanelKey[] = [
  'nowServing',
  'waitingQueue',
  'callHistory',
  'countersServing',
  'runningText',
];

export const TV_PANEL_SIZE_MIN = 1;
export const TV_PANEL_SIZE_MAX = 4;

/**
 * The PRD-default layout: every panel visible, the now-serving hero at the
 * largest size share, the three content panels at medium, and `runningText` as
 * the fixed footer. `runningText.order`/`size` are stored for map uniformity
 * but ignored by the TV (always the last footer).
 */
export const DEFAULT_TV_PANEL_LAYOUT: TvPanelLayoutMap = {
  nowServing: { visible: true, order: 0, size: 4 },
  waitingQueue: { visible: true, order: 1, size: 2 },
  callHistory: { visible: true, order: 2, size: 2 },
  countersServing: { visible: true, order: 3, size: 2 },
  runningText: { visible: true, order: 4, size: 2 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSizeInRange(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TV_PANEL_SIZE_MIN &&
    value <= TV_PANEL_SIZE_MAX
  );
}

/**
 * Per-panel TV layout (visibility + order + size), persisted on
 * {@link SystemConfiguration} as a JSONB map column (the
 * `service_themes` / `daily_reset_policy` nested-VO precedent, not the scalar
 * `brand_color` column — a panel→config map is a nested value object). The TV
 * fetches `GET /api/system/config` at boot, reads the map, and renders the
 * visible panels in `order` with `size` as the flex weight (all-visible + the
 * PRD-default order/sizes is the default, so a store that never configures
 * this keeps the existing TV layout — zero visual regression, mirroring
 * `ServiceThemes`).
 *
 * `of()` is permissive on *missing* keys (a missing key defaults to its
 * `DEFAULT_TV_PANEL_LAYOUT` entry) so a reconstituted row from before this
 * column existed, or a defensively-empty column, recovers to the default
 * layout without a migration. It is strict only on *present* keys: a present
 * key with a non-object value, or a present field with the wrong type / out of
 * range value, throws `InvalidValueObjectException` (→ HTTP 400) so a
 * malformed PUT fails fast (NFR-REL-02 — no illegal layout burns a write). A
 * non-object `raw` (e.g. the boot window `undefined` before the column exists,
 * or a JSON `null`) recovers to the default rather than throwing, matching
 * `ServiceThemes.of(row.service_themes ?? undefined)` defensive reconstitution.
 *
 * Not change-gated for audit — `tvPanelLayout` is an appearance concern, like
 * `brandColor`/`serviceThemes`, and is not in the NFR-SEC-02 audited list
 * (manual reset, state-schema, routing). `equals` is inherited (structural
 * deep-equal) and available if a future ticket adds layout-change diff-audit.
 */
export class TvPanelLayout extends ValueObject<TvPanelLayoutMap> {
  private constructor(map: TvPanelLayoutMap) {
    super(map);
  }

  public static of(raw: unknown): TvPanelLayout {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → default layout. A present-but-wrong-shape value (string, array,
    // number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return TvPanelLayout.DEFAULT;
    }
    if (!isPlainObject(raw)) {
      throw new InvalidValueObjectException(
        `tv panel layout must be an object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map = {} as TvPanelLayoutMap;
    for (const key of TV_PANEL_KEYS) {
      const entry = incoming[key];
      if (entry === undefined || entry === null) {
        // Missing key → per-key default (lazy-key reconstitution).
        const d = DEFAULT_TV_PANEL_LAYOUT[key];
        map[key] = { visible: d.visible, order: d.order, size: d.size };
        continue;
      }
      if (!isPlainObject(entry)) {
        throw new InvalidValueObjectException(
          `tv panel layout '${key}' must be an object, got '${String(entry)}'`,
        );
      }
      const e = entry as Record<string, unknown>;
      // `visible` must be a boolean when present; missing/null defaults to the
      // per-key default's visible.
      const visibleRaw =
        e.visible === undefined || e.visible === null
          ? DEFAULT_TV_PANEL_LAYOUT[key].visible
          : e.visible;
      if (typeof visibleRaw !== 'boolean') {
        throw new InvalidValueObjectException(
          `tv panel layout '${key}.visible' must be a boolean, got '${String(visibleRaw)}'`,
        );
      }
      const visible: boolean = visibleRaw;
      // `order` must be a non-negative integer when present; missing/null
      // defaults to the per-key default's order.
      const orderRaw =
        e.order === undefined || e.order === null
          ? DEFAULT_TV_PANEL_LAYOUT[key].order
          : e.order;
      if (!isNonNegativeInteger(orderRaw)) {
        throw new InvalidValueObjectException(
          `tv panel layout '${key}.order' must be a non-negative integer, got '${String(orderRaw)}'`,
        );
      }
      const order: number = orderRaw;
      // `size` must be an integer in `[1..4]` when present; missing/null
      // defaults to the per-key default's size.
      const sizeRaw =
        e.size === undefined || e.size === null
          ? DEFAULT_TV_PANEL_LAYOUT[key].size
          : e.size;
      if (!isSizeInRange(sizeRaw)) {
        throw new InvalidValueObjectException(
          `tv panel layout '${key}.size' must be an integer in [${TV_PANEL_SIZE_MIN}..${TV_PANEL_SIZE_MAX}], got '${String(sizeRaw)}'`,
        );
      }
      const size: number = sizeRaw;
      map[key] = { visible, order, size };
    }
    return new TvPanelLayout(map);
  }

  /** The PRD-default layout — every panel visible, hero biggest, footer last.
   * Matches `ServiceThemes.DEFAULT` / `BrandColor.DEFAULT` for zero visual
   * regression. */
  public static DEFAULT: TvPanelLayout = TvPanelLayout.of(DEFAULT_TV_PANEL_LAYOUT);

  public get options(): TvPanelLayoutMap {
    return this.props;
  }

  /** Returns a deep copy of the layout map so callers can mutate the DTO
   * without affecting the VO (the values are nested objects, not primitives,
   * so a shallow spread is not enough — each `TvPanelConfig` is rebuilt). */
  public toDto(): TvPanelLayoutMap {
    const map = {} as TvPanelLayoutMap;
    for (const key of TV_PANEL_KEYS) {
      const c = this.props[key];
      map[key] = { visible: c.visible, order: c.order, size: c.size };
    }
    return map;
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}