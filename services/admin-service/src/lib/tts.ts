import { DEFAULT_TTS_CONFIGURATION, type TtsConfigurationDto } from '../api/types';

/**
 * Speed bounds offered by `/tts-config`, mirroring core-api's `TtsConfiguration`
 * value object. Deliberately narrower than what `tts-service` itself accepts
 * ([0.25, 4.0]): that service treats an out-of-range knob as a misconfiguration
 * and falls back to its ENTIRE default settings object, so the ranges get
 * narrower, never wider, at each step outward. Widening here means widening
 * core-api first (the QUE-34 lock-step rule).
 */
export const MIN_TTS_SPEED = 0.5;
export const MAX_TTS_SPEED = 2.0;
/** Slider granularity. 0.05 is fine enough to hear a difference and coarse
 *  enough that the read-out stays a short, memorable number. */
export const TTS_SPEED_STEP = 0.05;

/** Volume bounds. These match `tts-service` exactly — the whole usable range is
 *  already the engine's range, so there is no headroom to give up. */
export const MIN_TTS_VOLUME = 0.0;
export const MAX_TTS_VOLUME = 2.0;
export const TTS_VOLUME_STEP = 0.05;

/** Pause bounds in milliseconds. The ceiling is a usability guard rather than an
 *  engine limit: the announcement has three seams, so 2000 ms already adds six
 *  seconds of silence — past the point where a waiting room hears a stall. */
export const MIN_TTS_PAUSE_MS = 0;
export const MAX_TTS_PAUSE_MS = 2000;
/** Step for the pause input. 50 ms is roughly the smallest change a listener can
 *  pick out, so a finer step would only produce values nobody can hear apart. */
export const TTS_PAUSE_STEP_MS = 50;

/**
 * Client-side announcement-delivery validation. The `/tts-config` page renders
 * `min`/`max`/`step`-constrained inputs, so an invalid value is not
 * constructable through the UI — but a direct API prefill (or a corrupt GET)
 * could carry one. This guard mirrors the UI-reachable subset of the backend
 * `TtsConfiguration` value object
 * (`core-api`'s `domain/store-config/value-objects/tts-configuration.ts`): speed
 * and volume are finite numbers inside their ranges, `pauseMs` is a whole number
 * of milliseconds inside its range. The two grammars stay in lock-step; a
 * divergence is a bug (the QUE-34 mirroring rule).
 *
 * @returns a list of Indonesian error strings for `config`; empty when valid
 *  (mirrors the `validatePrinterConfiguration` `string[]` contract).
 */
export function validateTtsConfiguration(config: TtsConfigurationDto): string[] {
  const errors: string[] = [];
  // `Number.isFinite` narrows at runtime but not in TS (see memory
  // `number-isfinite-not-a-type-predicate`); the explicit comparisons below are
  // the runtime check and need no further narrowing.
  if (
    !Number.isFinite(config.speed) ||
    config.speed < MIN_TTS_SPEED ||
    config.speed > MAX_TTS_SPEED
  ) {
    errors.push(`Kecepatan harus antara ${MIN_TTS_SPEED}× dan ${MAX_TTS_SPEED}×.`);
  }
  if (
    !Number.isFinite(config.volume) ||
    config.volume < MIN_TTS_VOLUME ||
    config.volume > MAX_TTS_VOLUME
  ) {
    errors.push('Volume harus antara 0% dan 200%.');
  }
  if (
    !Number.isInteger(config.pauseMs) ||
    config.pauseMs < MIN_TTS_PAUSE_MS ||
    config.pauseMs > MAX_TTS_PAUSE_MS
  ) {
    errors.push(
      `Jeda harus bilangan bulat ${MIN_TTS_PAUSE_MS}–${MAX_TTS_PAUSE_MS} milidetik.`,
    );
  }
  return errors;
}

/** True when `config` passes every {@link validateTtsConfiguration} check. */
export function isValidTtsConfiguration(config: TtsConfigurationDto): boolean {
  return validateTtsConfiguration(config).length === 0;
}

/**
 * Coerces an untrusted/partial `ttsConfiguration` from a GET projection into a
 * complete {@link TtsConfigurationDto}, defaulting an unknown/missing field
 * (mirrors the backend VO's permissive reconstitution). Used at `toForm` so the
 * form always carries a complete config even if the server returned a degraded
 * shape — the same belt-and-suspenders pattern as `coercePrinterConfiguration`.
 */
export function coerceTtsConfiguration(
  raw: Partial<TtsConfigurationDto> | undefined | null,
): TtsConfigurationDto {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TTS_CONFIGURATION };
  return {
    speed: coerceInRange(raw.speed, MIN_TTS_SPEED, MAX_TTS_SPEED, DEFAULT_TTS_CONFIGURATION.speed),
    volume: coerceInRange(
      raw.volume,
      MIN_TTS_VOLUME,
      MAX_TTS_VOLUME,
      DEFAULT_TTS_CONFIGURATION.volume,
    ),
    pauseMs: coerceInRange(
      raw.pauseMs,
      MIN_TTS_PAUSE_MS,
      MAX_TTS_PAUSE_MS,
      DEFAULT_TTS_CONFIGURATION.pauseMs,
      true,
    ),
  };
}

function coerceInRange(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
  integer = false,
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  if (integer && !Number.isInteger(raw)) return fallback;
  if (raw < min || raw > max) return fallback;
  return raw;
}

/**
 * URL of the `tts-service` preview clip for a candidate delivery.
 *
 * Built from the DRAFT rather than the saved config on purpose: a setting whose
 * only real acceptance test is "does it sound right" should not require a save
 * before it can be heard. `tts-service` supplies the words (omitting `text`
 * makes it announce a sample ticket), so the admin panel holds no Indonesian
 * queue phrasing — the boundary that service exists to enforce.
 *
 * Origin-relative so one URL works in Vite dev (proxy) and behind the gateway
 * (`location /tts/`), with no rewrite either way — the same shape the TV board
 * uses.
 */
export function ttsPreviewUrl(config: TtsConfigurationDto): string {
  const params = new URLSearchParams({
    speed: String(config.speed),
    volume: String(config.volume),
    pauseMs: String(config.pauseMs),
  });
  return `/tts/preview?${params.toString()}`;
}
