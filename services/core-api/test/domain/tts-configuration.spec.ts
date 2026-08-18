import { InvalidValueObjectException } from '../../src/domain/shared/errors';
import {
  MAX_PAUSE_MS,
  MAX_SPEED,
  MAX_VOLUME,
  MIN_PAUSE_MS,
  MIN_SPEED,
  MIN_VOLUME,
  TtsConfiguration,
  type TtsConfigurationDto,
} from '../../src/domain/store-config/value-objects/tts-configuration';

const DEFAULT_DTO: TtsConfigurationDto = {
  speed: 1.0,
  volume: 1.0,
  pauseMs: 0,
};

describe('TtsConfiguration', () => {
  it('of(undefined) / of(null) → DEFAULT (speed 1.0, no added pause = zero behavior change)', () => {
    expect(TtsConfiguration.of(undefined)).toBe(TtsConfiguration.DEFAULT);
    expect(TtsConfiguration.of(null)).toBe(TtsConfiguration.DEFAULT);
    expect(TtsConfiguration.DEFAULT.toDto()).toEqual(DEFAULT_DTO);
  });

  it('of({}) → all fields default (forward-compatible partial input)', () => {
    const cfg = TtsConfiguration.of({});
    expect(cfg.toDto()).toEqual(DEFAULT_DTO);
    expect(cfg.speed).toBe(1.0);
    expect(cfg.volume).toBe(1.0);
    expect(cfg.pauseMs).toBe(0);
  });

  it('round-trips a fully-specified config via toDto()', () => {
    const input: TtsConfigurationDto = { speed: 0.9, volume: 1.4, pauseMs: 400 };
    const cfg = TtsConfiguration.of(input);
    expect(cfg.toDto()).toEqual(input);
    expect(cfg.speed).toBe(0.9);
    expect(cfg.volume).toBe(1.4);
    expect(cfg.pauseMs).toBe(400);
  });

  it('accepts a partial input (only pauseMs, rest defaults)', () => {
    const cfg = TtsConfiguration.of({ pauseMs: 250 });
    expect(cfg.toDto()).toEqual({ speed: 1.0, volume: 1.0, pauseMs: 250 });
  });

  it('toDto() returns an independent copy (mutating it does not affect the VO)', () => {
    const cfg = TtsConfiguration.of({ speed: 1.2, volume: 0.8, pauseMs: 300 });
    const dto = cfg.toDto();
    dto.speed = 2.0;
    dto.pauseMs = 1;
    expect(cfg.speed).toBe(1.2);
    expect(cfg.pauseMs).toBe(300);
    expect(cfg.toDto()).toEqual({ speed: 1.2, volume: 0.8, pauseMs: 300 });
  });

  it.each([['a string'], [42], [[]], [true]])(
    'rejects a non-object raw (%p) — a malformed PUT must not silently default',
    (raw) => {
      expect(() => TtsConfiguration.of(raw)).toThrow(InvalidValueObjectException);
    },
  );

  describe('speed', () => {
    // The lower/upper bounds are DELIBERATELY narrower than tts-service's own
    // TtsSettings range of [0.25, 4.0]. That service replaces its WHOLE settings
    // object with a fallback when a knob is out of range, so anything core-api
    // accepts must be inside the engine's range with room to spare.
    it.each([[MIN_SPEED], [MAX_SPEED], [1.0], [0.75], [1.25]])(
      'accepts %p',
      (speed) => {
        expect(TtsConfiguration.of({ speed }).speed).toBe(speed);
      },
    );

    it.each([[0.49], [2.01], [0], [-1], [NaN], [Infinity], ['1.0'], [null], [{}], [true]])(
      'rejects %p',
      (speed) => {
        expect(() => TtsConfiguration.of({ speed })).toThrow(InvalidValueObjectException);
      },
    );

    it('stays inside the range tts-service accepts', () => {
      // Pins the subset relationship the doc comment claims: TtsSettings in
      // services/tts-service/app/domain/tts_engine.py allows [0.25, 4.0].
      expect(MIN_SPEED).toBeGreaterThanOrEqual(0.25);
      expect(MAX_SPEED).toBeLessThanOrEqual(4.0);
    });
  });

  describe('volume', () => {
    it.each([[MIN_VOLUME], [MAX_VOLUME], [1.0], [0.5]])('accepts %p', (volume) => {
      expect(TtsConfiguration.of({ volume }).volume).toBe(volume);
    });

    it.each([[-0.01], [2.01], [NaN], [Infinity], ['1'], [null], [[]]])(
      'rejects %p',
      (volume) => {
        expect(() => TtsConfiguration.of({ volume })).toThrow(InvalidValueObjectException);
      },
    );

    it('matches the range tts-service accepts exactly', () => {
      expect(MIN_VOLUME).toBe(0.0);
      expect(MAX_VOLUME).toBe(2.0);
    });
  });

  describe('pauseMs', () => {
    it.each([[MIN_PAUSE_MS], [MAX_PAUSE_MS], [400], [50]])('accepts %p', (pauseMs) => {
      expect(TtsConfiguration.of({ pauseMs }).pauseMs).toBe(pauseMs);
    });

    it.each([[-1], [2001], [NaN], [Infinity], ['400'], [null], [{}]])(
      'rejects %p',
      (pauseMs) => {
        expect(() => TtsConfiguration.of({ pauseMs })).toThrow(InvalidValueObjectException);
      },
    );

    it('rejects a fractional millisecond — a duration, not a preference', () => {
      // Deliberately separate from the it.each above: 250.5 is inside the range
      // and finite, so it can only be caught by the integer rule. Speed and
      // volume accept fractions, so this is the one knob where that rule exists
      // and the one place a copy-paste of the multiplier reader would regress.
      expect(() => TtsConfiguration.of({ pauseMs: 250.5 })).toThrow(
        InvalidValueObjectException,
      );
    });
  });

  it('names the offending field in the error message', () => {
    // The admin page maps errors to fields by substring, so a generic message
    // would leave a bad value un-highlighted.
    expect(() => TtsConfiguration.of({ speed: 9 })).toThrow(/speed/);
    expect(() => TtsConfiguration.of({ volume: 9 })).toThrow(/volume/);
    expect(() => TtsConfiguration.of({ pauseMs: 9999 })).toThrow(/pauseMs/);
  });

  it('toString() returns the JSON props', () => {
    const cfg = TtsConfiguration.of({ speed: 0.9, volume: 1, pauseMs: 400 });
    expect(JSON.parse(cfg.toString())).toEqual({ speed: 0.9, volume: 1, pauseMs: 400 });
  });

  it('equals() is structural (inherited from ValueObject)', () => {
    const a = TtsConfiguration.of({ speed: 0.9, volume: 1, pauseMs: 400 });
    const b = TtsConfiguration.of({ speed: 0.9, volume: 1, pauseMs: 400 });
    const c = TtsConfiguration.of({ speed: 0.9, volume: 1, pauseMs: 401 });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(TtsConfiguration.of({}).equals(TtsConfiguration.DEFAULT)).toBe(true);
  });
});
