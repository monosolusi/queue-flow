import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_TTS_PAUSE_MS,
  MAX_TTS_SPEED,
  MAX_TTS_VOLUME,
  MIN_TTS_PAUSE_MS,
  MIN_TTS_SPEED,
  MIN_TTS_VOLUME,
  coerceTtsConfiguration,
  isValidTtsConfiguration,
  ttsPreviewUrl,
  validateTtsConfiguration,
} from './tts';
import { DEFAULT_TTS_CONFIGURATION } from '../api/types';

describe('validateTtsConfiguration', () => {
  it('accepts the default delivery', () => {
    expect(validateTtsConfiguration(DEFAULT_TTS_CONFIGURATION)).toEqual([]);
    expect(isValidTtsConfiguration(DEFAULT_TTS_CONFIGURATION)).toBe(true);
  });

  it.each([MIN_TTS_SPEED, MAX_TTS_SPEED, 0.75, 1.25])('accepts speed %p', (speed) => {
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, speed })).toEqual([]);
  });

  it.each([0.49, 2.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects speed %p',
    (speed) => {
      expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, speed })).toHaveLength(1);
    },
  );

  it.each([-0.01, 2.01, Number.NaN])('rejects volume %p', (volume) => {
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, volume })).toHaveLength(1);
  });

  it.each([-1, 2001, 250.5, Number.NaN])('rejects pauseMs %p', (pauseMs) => {
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, pauseMs })).toHaveLength(1);
  });

  it('names the offending field, because the page maps errors to inputs by substring', () => {
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, speed: 9 })[0]).toContain(
      'Kecepatan',
    );
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, volume: 9 })[0]).toContain(
      'Volume',
    );
    expect(validateTtsConfiguration({ ...DEFAULT_TTS_CONFIGURATION, pauseMs: 9999 })[0]).toContain(
      'Jeda',
    );
  });
});

describe('coerceTtsConfiguration', () => {
  it('defaults a missing or non-object raw', () => {
    expect(coerceTtsConfiguration(undefined)).toEqual(DEFAULT_TTS_CONFIGURATION);
    expect(coerceTtsConfiguration(null)).toEqual(DEFAULT_TTS_CONFIGURATION);
  });

  it('defaults each field independently', () => {
    expect(coerceTtsConfiguration({ pauseMs: 400 })).toEqual({ speed: 1, volume: 1, pauseMs: 400 });
  });

  it('replaces an out-of-range or fractional field with its default', () => {
    expect(coerceTtsConfiguration({ speed: 99, volume: -1, pauseMs: 12.5 })).toEqual(
      DEFAULT_TTS_CONFIGURATION,
    );
  });
});

describe('ttsPreviewUrl', () => {
  it('sends every knob and no text, so the panel holds no Indonesian phrasing', () => {
    const url = new URL(ttsPreviewUrl({ speed: 0.75, volume: 1.25, pauseMs: 350 }), 'http://x');
    expect(url.pathname).toBe('/tts/preview');
    expect(url.searchParams.get('speed')).toBe('0.75');
    expect(url.searchParams.get('volume')).toBe('1.25');
    expect(url.searchParams.get('pauseMs')).toBe('350');
    expect(url.searchParams.has('text')).toBe(false);
  });

  it('is origin-relative, so one URL works in Vite dev and behind the gateway', () => {
    expect(ttsPreviewUrl(DEFAULT_TTS_CONFIGURATION).startsWith('/tts/')).toBe(true);
  });
});

/**
 * Drift gate for the range constants, which are duplicated across a TS/TS
 * boundary the build cannot check (admin cannot import from core-api's `src`).
 *
 * The rule is "narrower, never wider, at each step outward" — and the direction
 * matters. Widening a bound HERE is the dangerous edit: the slider would then
 * offer a value core-api rejects, and the manager's only feedback is a "Gagal
 * menyimpan" toast on a control the UI told them was in range. Nothing else in
 * the repo fails when that happens.
 *
 * Reading the TypeScript source with `node:fs` is the established pattern for a
 * static guard in this tree (the CSS breakpoint guards do the same).
 */
describe('range lock-step with core-api', () => {
  const CORE_API_VO = resolve(
    __dirname,
    '../../../core-api/src/domain/store-config/value-objects/tts-configuration.ts',
  );

  function coreApiConstant(name: string): number {
    const source = readFileSync(CORE_API_VO, 'utf8');
    const match = new RegExp(`^export const ${name} = ([0-9.]+);$`, 'm').exec(source);
    // A missing constant means the VO was refactored and this guard silently
    // stopped guarding — fail loudly rather than skip.
    expect(match, `${name} not found in ${CORE_API_VO}`).not.toBeNull();
    return Number(match![1]);
  }

  it('offers exactly the speed range core-api accepts', () => {
    expect(MIN_TTS_SPEED).toBe(coreApiConstant('MIN_SPEED'));
    expect(MAX_TTS_SPEED).toBe(coreApiConstant('MAX_SPEED'));
  });

  it('offers exactly the volume range core-api accepts', () => {
    expect(MIN_TTS_VOLUME).toBe(coreApiConstant('MIN_VOLUME'));
    expect(MAX_TTS_VOLUME).toBe(coreApiConstant('MAX_VOLUME'));
  });

  it('offers exactly the pause range core-api accepts', () => {
    expect(MIN_TTS_PAUSE_MS).toBe(coreApiConstant('MIN_PAUSE_MS'));
    expect(MAX_TTS_PAUSE_MS).toBe(coreApiConstant('MAX_PAUSE_MS'));
  });
});
