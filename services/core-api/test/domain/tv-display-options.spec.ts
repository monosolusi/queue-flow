import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import { TvDisplayOptions } from '../../src/domain/store-config';

describe('TvDisplayOptions value object', () => {
  const ALL_TRUE = {
    showNowServing: true,
    showWaitingQueue: true,
    showCallHistory: true,
    showCountersServing: true,
    showRunningText: true,
  };

  describe('of', () => {
    it('accepts a full boolean map', () => {
      const t = TvDisplayOptions.of({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: false,
        showCountersServing: true,
        showRunningText: false,
      });
      expect(t.toDto()).toEqual({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: false,
        showCountersServing: true,
        showRunningText: false,
      });
    });

    it('defaults a missing key to true (lazy-key reconstitution)', () => {
      const t = TvDisplayOptions.of({ showNowServing: false } as Record<string, unknown>);
      expect(t.toDto()).toEqual({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      });
    });

    it('defaults a null key value to true', () => {
      const t = TvDisplayOptions.of({
        showNowServing: false,
        showWaitingQueue: null,
        showCallHistory: null,
        showCountersServing: null,
        showRunningText: null,
      });
      expect(t.toDto()).toEqual({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      });
    });

    it('recovers undefined (boot-window missing column) to all-true', () => {
      expect(TvDisplayOptions.of(undefined).toDto()).toEqual(ALL_TRUE);
    });

    it('recovers null (JSON null) to all-true', () => {
      expect(TvDisplayOptions.of(null).toDto()).toEqual(ALL_TRUE);
    });

    it('ignores unknown keys (only the 5 canonical keys are read)', () => {
      const t = TvDisplayOptions.of({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
        // an extra key from a future/direct-API payload is not a canonical toggle
        unknown: false,
      } as Record<string, unknown>);
      expect(t.toDto()).toEqual({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      });
    });
  });

  describe('rejections', () => {
    it.each([
      ['a string', 'showNowServing:true'],
      ['an array', ['showNowServing', true]],
      ['a number', 5],
    ])('rejects a non-object raw (%s) with InvalidValueObjectException', (_label, raw) => {
      expect(() => TvDisplayOptions.of(raw)).toThrow(InvalidValueObjectException);
    });

    it('rejects a present-but-non-boolean value', () => {
      expect(() =>
        TvDisplayOptions.of({
          showNowServing: 'yes',
          showWaitingQueue: true,
          showCallHistory: true,
          showCountersServing: true,
          showRunningText: true,
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });

    it('rejects a non-boolean value (e.g. number) without a TypeError', () => {
      expect(() =>
        TvDisplayOptions.of({
          showNowServing: 1,
          showWaitingQueue: true,
          showCallHistory: true,
          showCountersServing: true,
          showRunningText: true,
        } as Record<string, unknown>),
      ).toThrow(InvalidValueObjectException);
    });
  });

  describe('DEFAULT', () => {
    it('is all-true (zero visual regression, preserves existing TV layout)', () => {
      expect(TvDisplayOptions.DEFAULT.toDto()).toEqual(ALL_TRUE);
    });

    it('is the same instance recovered from undefined', () => {
      expect(TvDisplayOptions.of(undefined)).toBe(TvDisplayOptions.DEFAULT);
      expect(TvDisplayOptions.of(null)).toBe(TvDisplayOptions.DEFAULT);
    });
  });

  describe('toDto', () => {
    it('returns a defensive copy (mutating it does not affect the VO)', () => {
      const t = TvDisplayOptions.of({
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      });
      const dto = t.toDto();
      dto.showNowServing = true;
      expect(t.toDto().showNowServing).toBe(false);
    });
  });

  describe('equals', () => {
    it('is structural over the per-panel map', () => {
      expect(
        TvDisplayOptions.of({
          showNowServing: false,
          showWaitingQueue: true,
          showCallHistory: true,
          showCountersServing: true,
          showRunningText: true,
        }).equals(
          TvDisplayOptions.of({
            showNowServing: false,
            showWaitingQueue: true,
            showCallHistory: true,
            showCountersServing: true,
            showRunningText: true,
          }),
        ),
      ).toBe(true);
      expect(
        TvDisplayOptions.of({
          showNowServing: false,
          showWaitingQueue: true,
          showCallHistory: true,
          showCountersServing: true,
          showRunningText: true,
        }).equals(TvDisplayOptions.DEFAULT),
      ).toBe(false);
    });
  });

  describe('toString', () => {
    it('JSON-serializes the per-panel map', () => {
      const map = {
        showNowServing: false,
        showWaitingQueue: true,
        showCallHistory: true,
        showCountersServing: true,
        showRunningText: true,
      };
      expect(TvDisplayOptions.of(map).toString()).toBe(JSON.stringify(map));
    });
  });
});