import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TV_GRID_LAYOUT,
  GRID_COLS,
  GRID_MAX_ROWS,
  GRID_MIN_H,
  GRID_MIN_W,
  type TvComponentType,
  type TvGridLayout,
  type TvWidget,
} from '../api/types';
import {
  TV_COMPONENT_LABELS,
  addWidget,
  coerceTvGridLayout,
  defaultTvGridLayout,
  findFreeSpot,
  hasOverlap,
  isValidTvGridLayout,
  moveWidget,
  newWidgetId,
  rectsOverlap,
  removeWidget,
  resizeWidget,
  validateTvGridLayout,
} from './tv-grid-layout';

/** A valid widget with a fresh id (crypto.randomUUID is available in jsdom). */
function widget(overrides: Partial<TvWidget> = {}): TvWidget {
  return {
    id: newWidgetId(),
    component: 'nowServing',
    x: 0,
    y: 0,
    w: 12,
    h: 4,
    ...overrides,
  };
}

const empty: TvGridLayout = [];

describe('tv-grid-layout (pure helpers)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rectsOverlap', () => {
    it('detects a full overlap', () => {
      expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 0, w: 4, h: 2 })).toBe(true);
    });
    it('detects a partial overlap', () => {
      expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 3, y: 1, w: 4, h: 2 })).toBe(true);
    });
    it('is false for axis-adjacent rects (share an edge, no shared cell)', () => {
      expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 4, y: 0, w: 4, h: 2 })).toBe(false);
      expect(rectsOverlap({ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 2, w: 4, h: 2 })).toBe(false);
    });
    it('is false for separated rects', () => {
      expect(rectsOverlap({ x: 0, y: 0, w: 2, h: 1 }, { x: 5, y: 5, w: 2, h: 1 })).toBe(false);
    });
  });

  describe('hasOverlap', () => {
    it('is false on an empty layout', () => {
      expect(hasOverlap(empty, { x: 0, y: 0, w: 4, h: 1 })).toBe(false);
    });
    it('detects overlap with any placed widget', () => {
      const layout: TvGridLayout = [widget({ x: 0, y: 0, w: 6, h: 2 })];
      expect(hasOverlap(layout, { x: 3, y: 0, w: 6, h: 2 })).toBe(true);
    });
    it('skips the exceptId widget', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 6, h: 2 });
      const layout: TvGridLayout = [a];
      expect(hasOverlap(layout, { x: 0, y: 0, w: 6, h: 2 }, 'a')).toBe(false);
      expect(hasOverlap(layout, { x: 0, y: 0, w: 6, h: 2 }, 'other')).toBe(true);
    });
  });

  describe('validateTvGridLayout / isValidTvGridLayout', () => {
    it('accepts the default layout', () => {
      expect(validateTvGridLayout(DEFAULT_TV_GRID_LAYOUT)).toEqual([]);
      expect(isValidTvGridLayout(DEFAULT_TV_GRID_LAYOUT)).toBe(true);
    });
    it('accepts an empty array (idle board)', () => {
      expect(validateTvGridLayout([])).toEqual([]);
    });
    it('rejects a non-array', () => {
      expect(validateTvGridLayout({})).toHaveLength(1);
      expect(validateTvGridLayout('x')).toHaveLength(1);
    });
    it('rejects a widget with a bad component enum', () => {
      const bad = [widget({ component: 'nope' as unknown as TvComponentType })];
      expect(validateTvGridLayout(bad).some((e) => e.includes('component'))).toBe(true);
    });
    it('rejects a widget with a missing/empty id', () => {
      const bad = [widget({ id: '' })];
      expect(validateTvGridLayout(bad).some((e) => e.includes('id'))).toBe(true);
    });
    it('rejects duplicate ids', () => {
      const bad = [widget({ id: 'dup', x: 0, y: 0, w: 1, h: 1 }), widget({ id: 'dup', x: 1, y: 0, w: 1, h: 1 })];
      expect(validateTvGridLayout(bad).some((e) => e.includes('ganda'))).toBe(true);
    });
    it('rejects out-of-range x / w and x+w overflow', () => {
      const overX = [widget({ x: GRID_COLS, w: 1 })];
      expect(validateTvGridLayout(overX).some((e) => e.includes('x'))).toBe(true);
      const overW = [widget({ x: 6, w: GRID_COLS })]; // 6 + 12 > 12
      expect(validateTvGridLayout(overW).some((e) => e.includes('x + w'))).toBe(true);
    });
    it('rejects y above GRID_MAX_ROWS-1 (mirrors core-api VO y ∈ [0, GRID_MAX_ROWS-1])', () => {
      const overY = [widget({ x: 0, y: GRID_MAX_ROWS, w: 12, h: 1 })];
      expect(validateTvGridLayout(overY).some((e) => e.includes('y'))).toBe(true);
      expect(isValidTvGridLayout(overY)).toBe(false);
    });
    it('rejects y+h > GRID_MAX_ROWS (mirrors core-api VO y+h ≤ GRID_MAX_ROWS)', () => {
      const overYH = [widget({ x: 0, y: GRID_MAX_ROWS - 2, w: 12, h: 4 })]; // 18+4=22 > 20
      expect(validateTvGridLayout(overYH).some((e) => e.includes('y + h'))).toBe(true);
      expect(isValidTvGridLayout(overYH)).toBe(false);
    });
    it('rejects overlapping widgets (when all individually well-formed)', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 6, h: 2 });
      const b = widget({ id: 'b', x: 3, y: 0, w: 6, h: 2 });
      expect(validateTvGridLayout([a, b]).some((e) => e.includes('tumpang tindih'))).toBe(true);
      expect(isValidTvGridLayout([a, b])).toBe(false);
    });
    it('skips the overlap check when an individual widget is malformed', () => {
      // A bad-component widget + a would-be-overlap: errors are only the field
      // errors (the overlap check is gated on errors.length === 0).
      const a = widget({ id: 'a', component: 'nope' as unknown as TvComponentType, x: 0, y: 0, w: 6, h: 2 });
      const b = widget({ id: 'b', x: 3, y: 0, w: 6, h: 2 });
      const errs = validateTvGridLayout([a, b]);
      expect(errs.some((e) => e.includes('component'))).toBe(true);
      expect(errs.some((e) => e.includes('tumpang tindih'))).toBe(false);
    });
  });

  describe('coerceTvGridLayout / defaultTvGridLayout', () => {
    it('coerces a valid array to a deep copy (not the same references)', () => {
      const raw = DEFAULT_TV_GRID_LAYOUT;
      const out = coerceTvGridLayout(raw);
      expect(out).toEqual(raw);
      expect(out).not.toBe(raw);
      expect(out[0]).not.toBe(raw[0]);
    });
    it('falls back to the default on a corrupt shape', () => {
      expect(coerceTvGridLayout({})).toEqual(DEFAULT_TV_GRID_LAYOUT);
      expect(coerceTvGridLayout([{ id: 'x', component: 'nope' as TvComponentType, x: 0, y: 0, w: 1, h: 1 }])).toEqual(
        DEFAULT_TV_GRID_LAYOUT,
      );
    });
    it('defaultTvGridLayout returns a fresh deep copy each call', () => {
      const a = defaultTvGridLayout();
      const b = defaultTvGridLayout();
      expect(a).toEqual(DEFAULT_TV_GRID_LAYOUT);
      expect(a).not.toBe(b);
      expect(a[0]).not.toBe(b[0]);
    });
  });

  describe('findFreeSpot', () => {
    it('finds (0,0) on an empty grid', () => {
      expect(findFreeSpot(empty, 4, 2)).toEqual({ x: 0, y: 0 });
    });
    it('returns null when no spot fits (full grid)', () => {
      const full: TvGridLayout = [widget({ x: 0, y: 0, w: GRID_COLS, h: GRID_MAX_ROWS })];
      expect(findFreeSpot(full, 1, 1)).toBeNull();
    });
    it('scans row-by-row, left-to-right for the first fit', () => {
      // A 6-wide block at (0,0); a 6-wide widget fits at (6,0).
      const layout: TvGridLayout = [widget({ x: 0, y: 0, w: 6, h: 2 })];
      expect(findFreeSpot(layout, 6, 1)).toEqual({ x: 6, y: 0 });
    });
  });

  describe('addWidget', () => {
    it('places at an explicit non-overlapping spot and returns a fresh id', () => {
      const result = addWidget(empty, 'runningText', { x: 0, y: 10 });
      expect(result).not.toBeNull();
      expect(result!.layout).toHaveLength(1);
      expect(result!.layout[0].x).toBe(0);
      expect(result!.layout[0].y).toBe(10);
      expect(result!.id).toEqual(result!.layout[0].id);
      expect(result!.layout[0].component).toBe('runningText');
    });
    it('falls back to findFreeSpot when the explicit spot overlaps', () => {
      const layout: TvGridLayout = [widget({ x: 0, y: 0, w: GRID_COLS, h: 4 })];
      // Explicit spot (0,0) overlaps the existing widget → free-spot search.
      const result = addWidget(layout, 'runningText', { x: 0, y: 0 });
      expect(result).not.toBeNull();
      // runningText default size is 12×1; the first free row is y=4. The new
      // widget is appended (the existing widget stays at index 0) — find it by
      // the returned id rather than assuming a position.
      const added = result!.layout.find((w) => w.id === result!.id);
      expect(added?.y).toBe(4);
    });
    it('returns null when no free spot exists', () => {
      const full: TvGridLayout = [widget({ x: 0, y: 0, w: GRID_COLS, h: GRID_MAX_ROWS })];
      expect(addWidget(full, 'nowServing')).toBeNull();
    });
    it('is immutable (does not mutate the input array)', () => {
      const layout: TvGridLayout = [];
      const out = addWidget(layout, 'runningText')!.layout;
      expect(layout).toHaveLength(0);
      expect(out).not.toBe(layout);
    });
  });

  describe('moveWidget', () => {
    it('moves a widget to a free cell', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 4, h: 2 });
      const out = moveWidget([a], 'a', 8, 0);
      expect(out[0].x).toBe(8);
      expect(out[0].y).toBe(0);
    });
    it('returns the original array on an overlap (no-op, ref-equal)', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 6, h: 2 });
      const b = widget({ id: 'b', x: 6, y: 0, w: 6, h: 2 });
      const layout: TvGridLayout = [a, b];
      expect(moveWidget(layout, 'a', 3, 0)).toBe(layout);
    });
    it('clamps x/y in-bounds', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 4, h: 2 });
      const out = moveWidget([a], 'a', -3, -2);
      expect(out[0].x).toBe(0);
      expect(out[0].y).toBe(0);
    });
    it('returns the original when the target equals the current position', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 4, h: 2 });
      const layout: TvGridLayout = [a];
      expect(moveWidget(layout, 'a', 0, 0)).toBe(layout);
    });
    it('returns the original for an unknown id', () => {
      const layout: TvGridLayout = [widget({ id: 'a' })];
      expect(moveWidget(layout, 'missing', 1, 1)).toBe(layout);
    });
  });

  describe('resizeWidget', () => {
    it('resizes a widget to a free rect', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 4, h: 2 });
      const out = resizeWidget([a], 'a', 8, 3);
      expect(out[0].w).toBe(8);
      expect(out[0].h).toBe(3);
    });
    it('returns the original on an overlap', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 6, h: 2 });
      const b = widget({ id: 'b', x: 6, y: 0, w: 6, h: 2 });
      const layout: TvGridLayout = [a, b];
      expect(resizeWidget(layout, 'a', 8, 2)).toBe(layout);
    });
    it('clamps w/h to the grid bounds (x + w ≤ GRID_COLS, y + h ≤ GRID_MAX_ROWS)', () => {
      const a = widget({ id: 'a', x: 6, y: 18, w: 4, h: 2 });
      const out = resizeWidget([a], 'a', GRID_COLS, GRID_MAX_ROWS);
      // x=6 → max w = 12 - 6 = 6; y=18 → max h = 20 - 18 = 2.
      expect(out[0].w).toBe(GRID_COLS - 6);
      expect(out[0].h).toBe(GRID_MAX_ROWS - 18);
    });
    it('clamps to the minimum size', () => {
      const a = widget({ id: 'a', x: 0, y: 0, w: 4, h: 2 });
      const out = resizeWidget([a], 'a', 0, 0);
      expect(out[0].w).toBe(GRID_MIN_W);
      expect(out[0].h).toBe(GRID_MIN_H);
    });
    it('returns the original for an unknown id', () => {
      const layout: TvGridLayout = [widget({ id: 'a' })];
      expect(resizeWidget(layout, 'missing', 2, 2)).toBe(layout);
    });
  });

  describe('removeWidget', () => {
    it('removes the named widget and is immutable', () => {
      const a = widget({ id: 'a' });
      const b = widget({ id: 'b' });
      const out = removeWidget([a, b], 'a');
      expect(out).toHaveLength(1);
      expect(out[0].id).toBe('b');
      // Original untouched.
      expect([a, b]).toHaveLength(2);
    });
    it('is a no-op (ref-equal) for an unknown id', () => {
      const layout: TvGridLayout = [widget({ id: 'a' })];
      expect(removeWidget(layout, 'missing')).toBe(layout);
    });
  });

  describe('TV_COMPONENT_LABELS', () => {
    it('labels every component type (no raw enum leaks to the manager)', () => {
      for (const key of ['nowServing', 'waitingQueue', 'callHistory', 'countersServing', 'runningText'] as const) {
        expect(TV_COMPONENT_LABELS[key]).toEqual(expect.any(String));
        expect(TV_COMPONENT_LABELS[key].length).toBeGreaterThan(0);
      }
    });
  });
});