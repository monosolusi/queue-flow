import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  TvPanelLayout,
  DEFAULT_TV_PANEL_LAYOUT,
} from '../../src/domain/store-config';

describe('TvPanelLayout value object', () => {
  const DEFAULT_DTO = {
    nowServing: { visible: true, order: 0, size: 4 },
    waitingQueue: { visible: true, order: 1, size: 2 },
    callHistory: { visible: true, order: 2, size: 2 },
    countersServing: { visible: true, order: 3, size: 2 },
    runningText: { visible: true, order: 4, size: 2 },
  };

  describe('of', () => {
    it('accepts a full layout map', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: false, order: 3, size: 2 },
        waitingQueue: { visible: true, order: 0, size: 4 },
        callHistory: { visible: false, order: 1, size: 1 },
        countersServing: { visible: true, order: 2, size: 3 },
        runningText: { visible: false, order: 4, size: 2 },
      });
      expect(t.toDto()).toEqual({
        nowServing: { visible: false, order: 3, size: 2 },
        waitingQueue: { visible: true, order: 0, size: 4 },
        callHistory: { visible: false, order: 1, size: 1 },
        countersServing: { visible: true, order: 2, size: 3 },
        runningText: { visible: false, order: 4, size: 2 },
      });
    });

    it('defaults a missing key to its per-key default (lazy-key reconstitution)', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: false, order: 5, size: 1 },
      } as Record<string, unknown>);
      expect(t.toDto()).toEqual({
        nowServing: { visible: false, order: 5, size: 1 },
        waitingQueue: DEFAULT_DTO.waitingQueue,
        callHistory: DEFAULT_DTO.callHistory,
        countersServing: DEFAULT_DTO.countersServing,
        runningText: DEFAULT_DTO.runningText,
      });
    });

    it('defaults a null key value to its per-key default', () => {
      const t = TvPanelLayout.of({
        nowServing: null,
        waitingQueue: null,
        callHistory: null,
        countersServing: null,
        runningText: null,
      });
      expect(t.toDto()).toEqual(DEFAULT_DTO);
    });

    it('defaults a missing field within a present key to the per-key default field', () => {
      // Only `visible` provided — `order` + `size` fall back to the per-key
      // default, while the provided `visible` is kept.
      const t = TvPanelLayout.of({
        nowServing: { visible: false },
      } as Record<string, unknown>);
      expect(t.toDto().nowServing).toEqual({
        visible: false,
        order: DEFAULT_DTO.nowServing.order,
        size: DEFAULT_DTO.nowServing.size,
      });
    });

    it('treats a null field within a present key as missing (per-key default)', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: null, order: null, size: null },
      } as Record<string, unknown>);
      expect(t.toDto().nowServing).toEqual(DEFAULT_DTO.nowServing);
    });

    it('recovers undefined (boot-window missing column) to DEFAULT', () => {
      expect(TvPanelLayout.of(undefined).toDto()).toEqual(DEFAULT_DTO);
    });

    it('recovers null (JSON null) to DEFAULT', () => {
      expect(TvPanelLayout.of(null).toDto()).toEqual(DEFAULT_DTO);
    });

    it('ignores unknown keys (only the 5 canonical keys are read)', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: true, order: 0, size: 4 },
        waitingQueue: { visible: true, order: 1, size: 2 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
        // an extra key from a future/direct-API payload is not canonical
        unknownPanel: { visible: false, order: 9, size: 1 },
      } as Record<string, unknown>);
      expect(t.toDto()).toEqual(DEFAULT_DTO);
    });

    it('does not share nested references with the input (defensive copy)', () => {
      const input = {
        nowServing: { visible: false, order: 0, size: 4 },
        waitingQueue: { visible: true, order: 1, size: 2 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
      };
      const t = TvPanelLayout.of(input);
      input.nowServing.visible = true;
      expect(t.toDto().nowServing.visible).toBe(false);
    });
  });

  describe('rejections', () => {
    it.each([
      ['a string', 'nowServing:true'],
      ['an array', ['nowServing', true]],
      ['a number', 5],
    ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
      expect(() => TvPanelLayout.of(raw)).toThrow(InvalidValueObjectException);
    });

    it('rejects a present key whose value is a non-object (string)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: 'true',
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a present key whose value is an array', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: [true, 0, 4],
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a present key whose value is null on a non-null raw (covered by missing-key default) — explicit non-object null inside a present key is caught', () => {
      // `null` for a whole key is treated as missing → per-key default (not a
      // rejection). This test documents that behavior explicitly so the
      // rejection boundary is unambiguous.
      expect(
        TvPanelLayout.of({
          nowServing: null,
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        }).toDto().nowServing,
      ).toEqual(DEFAULT_DTO.nowServing);
    });

    it('rejects a non-boolean visible (string)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: 'yes', order: 0, size: 4 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-boolean visible (number 1)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: 1, order: 0, size: 4 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-integer order (float)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: 1.5, size: 4 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a negative order', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: -1, size: 4 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-integer order (string)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: '0', size: 4 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-integer size (float)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: 0, size: 2.5 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects size below the minimum (0)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: 0, size: 0 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects size above the maximum (5)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: 0, size: 5 },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-number size (string)', () => {
      expect(() =>
        TvPanelLayout.of({
          nowServing: { visible: true, order: 0, size: '4' },
          waitingQueue: { visible: true, order: 1, size: 2 },
          callHistory: { visible: true, order: 2, size: 2 },
          countersServing: { visible: true, order: 3, size: 2 },
          runningText: { visible: true, order: 4, size: 2 },
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('accepts size at the boundaries (1 and 4)', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: true, order: 0, size: 1 },
        waitingQueue: { visible: true, order: 1, size: 4 },
        callHistory: { visible: true, order: 2, size: 1 },
        countersServing: { visible: true, order: 3, size: 4 },
        runningText: { visible: true, order: 4, size: 1 },
      });
      expect(t.toDto().nowServing.size).toBe(1);
      expect(t.toDto().waitingQueue.size).toBe(4);
    });
  });

  describe('DEFAULT', () => {
    it('matches DEFAULT_TV_PANEL_LAYOUT', () => {
      expect(TvPanelLayout.DEFAULT.toDto()).toEqual(DEFAULT_DTO);
      expect(DEFAULT_TV_PANEL_LAYOUT).toEqual(DEFAULT_DTO);
    });

    it('is the same instance recovered from undefined', () => {
      expect(TvPanelLayout.of(undefined)).toBe(TvPanelLayout.DEFAULT);
      expect(TvPanelLayout.of(null)).toBe(TvPanelLayout.DEFAULT);
    });
  });

  describe('toDto', () => {
    it('returns a deep copy (mutating a nested field does not affect the VO)', () => {
      const t = TvPanelLayout.of({
        nowServing: { visible: false, order: 0, size: 4 },
        waitingQueue: { visible: true, order: 1, size: 2 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
      });
      const dto = t.toDto();
      dto.nowServing.visible = true;
      dto.nowServing.order = 99;
      expect(t.toDto().nowServing.visible).toBe(false);
      expect(t.toDto().nowServing.order).toBe(0);
    });
  });

  describe('equals', () => {
    it('is structural over the per-panel map', () => {
      const a = TvPanelLayout.of({
        nowServing: { visible: false, order: 3, size: 2 },
        waitingQueue: { visible: true, order: 0, size: 4 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
      });
      const b = TvPanelLayout.of({
        nowServing: { visible: false, order: 3, size: 2 },
        waitingQueue: { visible: true, order: 0, size: 4 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
      });
      expect(a.equals(b)).toBe(true);
      expect(a.equals(TvPanelLayout.DEFAULT)).toBe(false);
    });
  });

  describe('toString', () => {
    it('JSON-serializes the per-panel map', () => {
      const map = {
        nowServing: { visible: false, order: 0, size: 4 },
        waitingQueue: { visible: true, order: 1, size: 2 },
        callHistory: { visible: true, order: 2, size: 2 },
        countersServing: { visible: true, order: 3, size: 2 },
        runningText: { visible: true, order: 4, size: 2 },
      };
      expect(TvPanelLayout.of(map).toString()).toBe(JSON.stringify(map));
    });
  });
});