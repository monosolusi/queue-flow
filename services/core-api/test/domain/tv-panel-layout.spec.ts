import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  TvPanelLayout,
  DEFAULT_TV_GRID_LAYOUT,
  GRID_COLS,
  GRID_MAX_ROWS,
  TV_COMPONENT_TYPES,
} from '../../src/domain/store-config';

describe('TvPanelLayout value object (widget-array grid model)', () => {
  describe('of', () => {
    it('accepts the PRD-default layout', () => {
      const t = TvPanelLayout.of(DEFAULT_TV_GRID_LAYOUT);
      expect(t.toDto()).toEqual(DEFAULT_TV_GRID_LAYOUT);
    });

    it('accepts a custom 2-widget non-overlapping layout', () => {
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 8, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 8, y: 0, w: 4, h: 4 },
      ]);
      expect(t.toDto()).toEqual([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 8, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 8, y: 0, w: 4, h: 4 },
      ]);
    });

    it('accepts an empty array (idle board — no panels)', () => {
      const t = TvPanelLayout.of([]);
      expect(t.toDto()).toEqual([]);
    });

    it('recovers undefined (boot-window missing column) to DEFAULT', () => {
      expect(TvPanelLayout.of(undefined).toDto()).toEqual(DEFAULT_TV_GRID_LAYOUT);
    });

    it('recovers null (JSON null) to DEFAULT', () => {
      expect(TvPanelLayout.of(null).toDto()).toEqual(DEFAULT_TV_GRID_LAYOUT);
    });

    it('ignores unknown extra properties on a widget', () => {
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4, extra: 'ignored', nested: { a: 1 } },
      ]);
      expect(t.toDto()).toEqual([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ]);
    });

    it('does not share references with the input (defensive copy)', () => {
      const input = [
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ];
      const t = TvPanelLayout.of(input);
      (input[0] as { x: number }).x = 99;
      expect(t.toDto()[0].x).toBe(0);
    });

    it('accepts edge-adjacent widgets (touching edges do NOT overlap)', () => {
      // w1 ends at col 6 (x=0,w=6 → [0,6)); w2 starts at col 6 → no overlap.
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 6, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 6, y: 0, w: 6, h: 4 },
      ]);
      expect(t.toDto()).toHaveLength(2);
    });

    it('accepts the max row boundary (y+h === GRID_MAX_ROWS)', () => {
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: GRID_MAX_ROWS },
      ]);
      expect(t.toDto()[0].h).toBe(GRID_MAX_ROWS);
    });
  });

  describe('rejections', () => {
    it.each([
      ['a string', 'nowServing'],
      ['a plain object', { nowServing: { visible: true } }],
      ['a number', 5],
    ])('rejects a non-array raw (%s) with InvalidValueObjectException', (_label, raw) => {
      expect(() => TvPanelLayout.of(raw)).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-object element (number)', () => {
      expect(() => TvPanelLayout.of([5] as unknown[])).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-object element (null)', () => {
      expect(() => TvPanelLayout.of([null] as unknown[])).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-object element (array)', () => {
      expect(() => TvPanelLayout.of([[1, 2]] as unknown[])).toThrow(InvalidValueObjectException);
    });

    it('rejects an empty-string id', () => {
      expect(() =>
        TvPanelLayout.of([{ id: '', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-string id (number)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 5, component: 'nowServing', x: 0, y: 0, w: 12, h: 4 }] as unknown[]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a duplicate id', () => {
      expect(() =>
        TvPanelLayout.of([
          { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 6, h: 4 },
          { id: 'w1', component: 'waitingQueue', x: 6, y: 0, w: 6, h: 4 },
        ]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-string component', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 5, x: 0, y: 0, w: 12, h: 4 }] as unknown[]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a component not in the enum', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'unknownPanel', x: 0, y: 0, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-integer x (float)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 1.5, y: 0, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-integer x (string)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: '0', y: 0, w: 12, h: 4 }] as unknown[]),
      ).toThrow(InvalidValueObjectException);
    });

    it(`rejects x below 0`, () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: -1, y: 0, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it(`rejects x above GRID_COLS-1`, () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: GRID_COLS, y: 0, w: 1, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a negative y', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: -1, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it(`rejects y above GRID_MAX_ROWS-1`, () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: GRID_MAX_ROWS, w: 12, h: 1 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects w below the minimum (0)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: 0, w: 0, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it(`rejects w above GRID_COLS`, () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: 0, w: GRID_COLS + 1, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects x+w > GRID_COLS (overflows the right edge)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 8, y: 0, w: 8, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects h below the minimum (0)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 0 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it(`rejects h above GRID_MAX_ROWS`, () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: GRID_MAX_ROWS + 1 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects y+h > GRID_MAX_ROWS (overflows the bottom edge)', () => {
      expect(() =>
        TvPanelLayout.of([{ id: 'w1', component: 'nowServing', x: 0, y: 18, w: 12, h: 4 }]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects overlapping widgets (column overlap)', () => {
      // w1 = cols [0,12), w2 = cols [0,6) → overlap in columns and rows.
      expect(() =>
        TvPanelLayout.of([
          { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
          { id: 'w2', component: 'waitingQueue', x: 0, y: 0, w: 6, h: 4 },
        ]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects overlapping widgets (partial cell overlap)', () => {
      // w1 = cols [0,6) rows [0,4); w2 = cols [3,9) rows [2,6) → overlap in
      // columns [3,6) and rows [2,4).
      expect(() =>
        TvPanelLayout.of([
          { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 6, h: 4 },
          { id: 'w2', component: 'waitingQueue', x: 3, y: 2, w: 6, h: 4 },
        ]),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects overlapping widgets (row overlap only, columns touch)', () => {
      // Columns are edge-adjacent (no col overlap) but rows overlap — no
      // overlap overall. This documents that BOTH axes must intersect.
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 6, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 6, y: 1, w: 6, h: 4 },
      ]);
      expect(t.toDto()).toHaveLength(2);
    });
  });

  describe('DEFAULT', () => {
    it('matches DEFAULT_TV_GRID_LAYOUT', () => {
      expect(TvPanelLayout.DEFAULT.toDto()).toEqual(DEFAULT_TV_GRID_LAYOUT);
    });

    it('is the same instance recovered from undefined', () => {
      expect(TvPanelLayout.of(undefined)).toBe(TvPanelLayout.DEFAULT);
      expect(TvPanelLayout.of(null)).toBe(TvPanelLayout.DEFAULT);
    });

    it('has one widget per component type, id === component', () => {
      const dto = TvPanelLayout.DEFAULT.toDto();
      expect(dto).toHaveLength(TV_COMPONENT_TYPES.length);
      for (const w of dto) {
        expect(w.id).toBe(w.component);
      }
    });
  });

  describe('toDto', () => {
    it('returns a deep copy (mutating a widget does not affect the VO)', () => {
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ]);
      const dto = t.toDto() as unknown as { id: string; x: number }[];
      dto[0].x = 99;
      dto[0].id = 'mutated';
      expect(t.toDto()[0].x).toBe(0);
      expect(t.toDto()[0].id).toBe('w1');
    });
  });

  describe('widgets getter', () => {
    it('exposes the widget array', () => {
      const t = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ]);
      expect(t.widgets).toHaveLength(1);
      expect(t.widgets[0].component).toBe('nowServing');
    });
  });

  describe('equals', () => {
    it('is structural over the widget array (order-sensitive)', () => {
      const a = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      ]);
      const b = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      ]);
      expect(a.equals(b)).toBe(true);
      expect(a.equals(TvPanelLayout.DEFAULT)).toBe(false);
    });

    it('distinguishes a different widget order (array order matters)', () => {
      const a = TvPanelLayout.of([
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
        { id: 'w2', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
      ]);
      const b = TvPanelLayout.of([
        { id: 'w2', component: 'waitingQueue', x: 0, y: 4, w: 6, h: 3 },
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ]);
      // deepEqual compares arrays index-by-index, so a different order is a
      // different layout — the VO is order-sensitive (the array encodes the
      // manager's intended z/render order).
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('toString', () => {
    it('JSON-serializes the widget array', () => {
      const layout = [
        { id: 'w1', component: 'nowServing', x: 0, y: 0, w: 12, h: 4 },
      ];
      expect(TvPanelLayout.of(layout).toString()).toBe(JSON.stringify(layout));
    });
  });
});