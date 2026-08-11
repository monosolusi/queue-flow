import { describe, expect, it } from 'vitest';
import {
  CONTENT_PANEL_KEYS,
  coerceTvPanelLayout,
  isValidTvPanelLayout,
  reorderPanels,
  setPanelSize,
  setPanelVisible,
  validateTvPanelLayout,
} from './tv-panel-layout';
import {
  DEFAULT_TV_PANEL_LAYOUT,
  TV_PANEL_KEYS,
  TV_PANEL_SIZE_MAX,
  TV_PANEL_SIZE_MIN,
} from '../api/types';

describe('tv-panel-layout pure helpers', () => {
  describe('CONTENT_PANEL_KEYS', () => {
    it('excludes runningText (the fixed footer)', () => {
      expect(CONTENT_PANEL_KEYS).toEqual([
        'nowServing',
        'waitingQueue',
        'callHistory',
        'countersServing',
      ]);
      expect(CONTENT_PANEL_KEYS).not.toContain('runningText');
    });
  });

  describe('validateTvPanelLayout / isValidTvPanelLayout', () => {
    it('the DEFAULT layout is valid', () => {
      expect(validateTvPanelLayout(DEFAULT_TV_PANEL_LAYOUT)).toEqual([]);
      expect(isValidTvPanelLayout(DEFAULT_TV_PANEL_LAYOUT)).toBe(true);
    });

    it('a non-object entry is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, nowServing: null as never };
      const errors = validateTvPanelLayout(bad);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('nowServing'))).toBe(true);
      expect(isValidTvPanelLayout(bad)).toBe(false);
    });

    it('a non-boolean visible is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, waitingQueue: { ...DEFAULT_TV_PANEL_LAYOUT.waitingQueue, visible: 'yes' as never } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('waitingQueue.visible'))).toBe(true);
    });

    it('a negative order is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, callHistory: { ...DEFAULT_TV_PANEL_LAYOUT.callHistory, order: -1 } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('callHistory.order'))).toBe(true);
    });

    it('a non-integer order is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, callHistory: { ...DEFAULT_TV_PANEL_LAYOUT.callHistory, order: 1.5 } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('callHistory.order'))).toBe(true);
    });

    it('a size below the min is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, nowServing: { ...DEFAULT_TV_PANEL_LAYOUT.nowServing, size: 0 } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('nowServing.size'))).toBe(true);
    });

    it('a size above the max is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, nowServing: { ...DEFAULT_TV_PANEL_LAYOUT.nowServing, size: TV_PANEL_SIZE_MAX + 1 } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('nowServing.size'))).toBe(true);
    });

    it('a non-integer size is flagged', () => {
      const bad = { ...DEFAULT_TV_PANEL_LAYOUT, nowServing: { ...DEFAULT_TV_PANEL_LAYOUT.nowServing, size: 2.5 } };
      expect(validateTvPanelLayout(bad).some((e) => e.includes('nowServing.size'))).toBe(true);
    });
  });

  describe('coerceTvPanelLayout', () => {
    it('undefined -> DEFAULT (a fresh map, not the same reference)', () => {
      const out = coerceTvPanelLayout(undefined);
      expect(out).toEqual(DEFAULT_TV_PANEL_LAYOUT);
      expect(out.nowServing).not.toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing);
    });

    it('null -> DEFAULT', () => {
      expect(coerceTvPanelLayout(null)).toEqual(DEFAULT_TV_PANEL_LAYOUT);
    });

    it('a partial entry is filled from the DEFAULT for missing fields', () => {
      const out = coerceTvPanelLayout({
        nowServing: { visible: false },
      });
      expect(out.nowServing.visible).toBe(false);
      // order + size default from DEFAULT_TV_PANEL_LAYOUT.nowServing
      expect(out.nowServing.order).toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing.order);
      expect(out.nowServing.size).toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing.size);
      // other keys untouched (default)
      expect(out.waitingQueue).toEqual(DEFAULT_TV_PANEL_LAYOUT.waitingQueue);
    });

    it('an invalid value is dropped (defaults retained)', () => {
      const out = coerceTvPanelLayout({
        nowServing: { visible: 'maybe', order: -3, size: 99 } as never,
      });
      expect(out.nowServing.visible).toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing.visible);
      expect(out.nowServing.order).toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing.order);
      expect(out.nowServing.size).toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing.size);
    });

    it('a non-object raw entry is skipped', () => {
      const out = coerceTvPanelLayout({ nowServing: 'broken' as never });
      expect(out.nowServing).toEqual(DEFAULT_TV_PANEL_LAYOUT.nowServing);
    });
  });

  describe('reorderPanels', () => {
    it('moving a panel up reassigns order 0..3 across the content panels', () => {
      // Move callHistory (order 2, index 2) to index 0.
      const out = reorderPanels(DEFAULT_TV_PANEL_LAYOUT, 2, 0);
      const contentOrdered = [...CONTENT_PANEL_KEYS].sort(
        (a, b) => out[a].order - out[b].order,
      );
      expect(contentOrdered).toEqual(['callHistory', 'nowServing', 'waitingQueue', 'countersServing']);
      // order is a dense 0..3
      const orders = contentOrdered.map((k) => out[k].order);
      expect(orders).toEqual([0, 1, 2, 3]);
      // runningText order stays 4
      expect(out.runningText.order).toBe(4);
    });

    it('moving a panel down reassigns order', () => {
      // Move nowServing (index 0) to index 3.
      const out = reorderPanels(DEFAULT_TV_PANEL_LAYOUT, 0, 3);
      const contentOrdered = [...CONTENT_PANEL_KEYS].sort(
        (a, b) => out[a].order - out[b].order,
      );
      expect(contentOrdered).toEqual(['waitingQueue', 'callHistory', 'countersServing', 'nowServing']);
    });

    it('a no-op move (from === to) returns an equal layout (fresh reference)', () => {
      const out = reorderPanels(DEFAULT_TV_PANEL_LAYOUT, 1, 1);
      expect(out).toEqual(DEFAULT_TV_PANEL_LAYOUT);
      expect(out).not.toBe(DEFAULT_TV_PANEL_LAYOUT);
    });

    it('does not mutate the input', () => {
      const before = { ...DEFAULT_TV_PANEL_LAYOUT, nowServing: { ...DEFAULT_TV_PANEL_LAYOUT.nowServing } };
      reorderPanels(DEFAULT_TV_PANEL_LAYOUT, 0, 2);
      expect(DEFAULT_TV_PANEL_LAYOUT.nowServing.order).toBe(before.nowServing.order);
    });

    it('clamps out-of-range indices', () => {
      // from way above the range is clamped to the last index; to below 0 is
      // clamped to 0.
      const out = reorderPanels(DEFAULT_TV_PANEL_LAYOUT, 99, -99);
      const contentOrdered = [...CONTENT_PANEL_KEYS].sort(
        (a, b) => out[a].order - out[b].order,
      );
      // The last content panel (countersServing) moved to index 0.
      expect(contentOrdered[0]).toBe('countersServing');
    });
  });

  describe('setPanelSize', () => {
    it('sets the size and returns a fresh map', () => {
      const out = setPanelSize(DEFAULT_TV_PANEL_LAYOUT, 'nowServing', 2);
      expect(out.nowServing.size).toBe(2);
      expect(DEFAULT_TV_PANEL_LAYOUT.nowServing.size).toBe(4);
      expect(out).not.toBe(DEFAULT_TV_PANEL_LAYOUT);
      expect(out.nowServing).not.toBe(DEFAULT_TV_PANEL_LAYOUT.nowServing);
    });

    it('clamps above the max', () => {
      expect(setPanelSize(DEFAULT_TV_PANEL_LAYOUT, 'nowServing', 99).nowServing.size).toBe(TV_PANEL_SIZE_MAX);
    });

    it('clamps below the min', () => {
      expect(setPanelSize(DEFAULT_TV_PANEL_LAYOUT, 'nowServing', 0).nowServing.size).toBe(TV_PANEL_SIZE_MIN);
    });

    it('leaves other panels untouched', () => {
      const out = setPanelSize(DEFAULT_TV_PANEL_LAYOUT, 'nowServing', 1);
      expect(out.waitingQueue).toEqual(DEFAULT_TV_PANEL_LAYOUT.waitingQueue);
    });
  });

  describe('setPanelVisible', () => {
    it('sets visible and returns a fresh map', () => {
      const out = setPanelVisible(DEFAULT_TV_PANEL_LAYOUT, 'callHistory', false);
      expect(out.callHistory.visible).toBe(false);
      expect(DEFAULT_TV_PANEL_LAYOUT.callHistory.visible).toBe(true);
      expect(out).not.toBe(DEFAULT_TV_PANEL_LAYOUT);
    });

    it('works for runningText', () => {
      const out = setPanelVisible(DEFAULT_TV_PANEL_LAYOUT, 'runningText', false);
      expect(out.runningText.visible).toBe(false);
    });
  });

  describe('TV_PANEL_KEYS coverage', () => {
    it('every key is covered by the DEFAULT', () => {
      for (const key of TV_PANEL_KEYS) {
        expect(DEFAULT_TV_PANEL_LAYOUT[key]).toBeDefined();
        expect(typeof DEFAULT_TV_PANEL_LAYOUT[key].visible).toBe('boolean');
        expect(Number.isInteger(DEFAULT_TV_PANEL_LAYOUT[key].order)).toBe(true);
        expect(Number.isInteger(DEFAULT_TV_PANEL_LAYOUT[key].size)).toBe(true);
      }
    });
  });
});