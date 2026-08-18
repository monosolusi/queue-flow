import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/** Slowest / fastest delivery the admin panel may configure, as a multiplier of
 *  the voice's recorded pace (1.0 = as recorded).
 *
 *  Deliberately NARROWER than `tts-service`'s own `TtsSettings` range of
 *  [0.25, 4.0]. That service treats an out-of-range knob as a misconfiguration
 *  and replaces the WHOLE settings object with its fallback — not just the
 *  offending field — so a store that had also picked a voice would silently
 *  lose it. Keeping this a strict subset makes that path unreachable from a
 *  value core-api accepted. Widening this range therefore requires widening
 *  `TtsSettings.__post_init__` FIRST. */
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;

/** Volume multiplier bounds. These MATCH `TtsSettings` exactly (0.0 mutes,
 *  2.0 is double). Unlike speed there is no headroom to give up: the whole
 *  usable range is already the engine's range. */
export const MIN_VOLUME = 0.0;
export const MAX_VOLUME = 2.0;

/** Silence inserted at each pause point inside the announcement, milliseconds.
 *
 *  `0` is the default and means "read as one continuous utterance" — the exact
 *  audio the board produced before this value object existed. The ceiling is a
 *  usability guard, not an engine limit: at 2000 ms a four-part announcement
 *  already carries six seconds of silence, well past the point where a waiting
 *  room hears a stall rather than a pause. */
export const MIN_PAUSE_MS = 0;
export const MAX_PAUSE_MS = 2000;

/** The validated, immutable announcement-delivery props. */
export interface TtsConfigurationProps {
  /** Speaking rate multiplier; `tts-service` maps it to Piper's
   *  `length_scale` as its reciprocal (speed 2.0 → length_scale 0.5). */
  readonly speed: number;
  /** Playback volume multiplier applied during synthesis. */
  readonly volume: number;
  /** Silence at each pause point inside the sentence, milliseconds. */
  readonly pauseMs: number;
}

/** Wire DTO (the shape returned by `toDto()` and carried on the config
 *  GET/PUT under the top-level `ttsConfiguration` field). Mutable so the
 *  admin client can edit it before sending. */
export interface TtsConfigurationDto {
  speed: number;
  volume: number;
  pauseMs: number;
}

/**
 * How the TV board's announcements are delivered — how fast they are read and
 * how much silence separates the parts of the sentence. Persisted on
 * {@link SystemConfiguration} as a single JSONB object column, the same
 * nested-value-object shape as `printerConfiguration`.
 *
 * **This value object is the producer for a contract that already has a
 * consumer.** `tts-service` polls `GET /api/system/config` every 30 s and reads
 * a top-level `ttsConfiguration` object
 * (`app/infrastructure/core_api_config_client.py`). Until this landed, core-api
 * never emitted the field, so every deployment ran on that client's hardcoded
 * fallback. The wire field NAMES here (`speed`, `volume`, `pauseMs`) are
 * therefore not ours to choose freely — they must match what that client
 * parses, which is what the config round-trip integration test pins.
 *
 * What core-api owns is the *configuration*; the words, the voice and the audio
 * pipeline stay in `tts-service`. core-api still never synthesizes or plays
 * sound, so there is no `domain/notification` context here.
 *
 * `engine` and `voice` are deliberately ABSENT. That client defaults both when
 * they are missing (`piper` / `id_ID-news_tts-medium`), and no admin surface
 * selects them today — carrying them here would be config nothing can change.
 * Adding them later needs no migration: they are sub-keys inside an existing
 * JSONB document, the `baudRate`-after-0013 precedent.
 *
 * `of()` is permissive on *missing* (an `undefined`/`null` raw from the
 * pre-migration boot window or a JSON `null`) so a row written before this
 * column existed recovers to the default. It is equally permissive on
 * *partially-missing* fields, so a client that sends only `{ speed }` is
 * accepted. It is strict only on *present-but-invalid* fields, which throw
 * `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails fast and
 * burns no write (NFR-REL-02).
 *
 * Not change-gated for audit — announcement delivery is an operational concern
 * like `printerConfiguration` and `tvPanelLayout`, and is not one of the three
 * NFR-SEC-02 audited changes (manual reset, state schema, routing).
 */
export class TtsConfiguration extends ValueObject<TtsConfigurationProps> {
  private constructor(props: TtsConfigurationProps) {
    super(props);
  }

  public static of(raw: unknown): TtsConfiguration {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → default delivery. A present-but-wrong-shape value (string, array,
    // number, boolean) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return TtsConfiguration.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `tts configuration must be a plain object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;

    const speed = readMultiplier(incoming.speed, 'speed', MIN_SPEED, MAX_SPEED);
    const volume = readMultiplier(incoming.volume, 'volume', MIN_VOLUME, MAX_VOLUME);

    // pauseMs: optional → 0 default; present-but-not-an-integer-in-range →
    // reject. Integer rather than float because it is a duration in
    // milliseconds — a fractional millisecond is a client bug, not a preference.
    const pauseMsRaw = incoming.pauseMs;
    let pauseMs: number;
    if (pauseMsRaw === undefined) {
      pauseMs = MIN_PAUSE_MS;
    } else if (
      typeof pauseMsRaw === 'number' &&
      Number.isInteger(pauseMsRaw) &&
      pauseMsRaw >= MIN_PAUSE_MS &&
      pauseMsRaw <= MAX_PAUSE_MS
    ) {
      // `Number.isInteger` already rejects NaN/Infinity/fractional, so no
      // separate `Number.isFinite` guard is needed here (unlike the multiplier
      // path below, which accepts fractions).
      pauseMs = pauseMsRaw;
    } else {
      throw new InvalidValueObjectException(
        `tts configuration.pauseMs must be an integer ${MIN_PAUSE_MS}..${MAX_PAUSE_MS}, got '${String(pauseMsRaw)}'`,
      );
    }

    return new TtsConfiguration({ speed, volume, pauseMs });
  }

  /** Speed 1.0, volume 1.0, no added pauses — the exact delivery the board had
   *  before this value object existed, so a store that never opens the settings
   *  page hears no change. */
  public static DEFAULT: TtsConfiguration = TtsConfiguration.of({
    speed: 1.0,
    volume: 1.0,
    pauseMs: 0,
  });

  public get speed(): number {
    return this.props.speed;
  }

  public get volume(): number {
    return this.props.volume;
  }

  public get pauseMs(): number {
    return this.props.pauseMs;
  }

  /** Returns a plain object copy so callers can mutate the DTO without
   *  affecting the VO (all props are primitives, so a shallow copy suffices). */
  public toDto(): TtsConfigurationDto {
    return {
      speed: this.props.speed,
      volume: this.props.volume,
      pauseMs: this.props.pauseMs,
    };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}

/**
 * Shared reader for the two fractional multipliers, which differ only in name
 * and bounds. Fractions are the point of these knobs (0.9× is the useful
 * setting), so `Number.isInteger` must NOT be applied — but `Number.isFinite`
 * must, or `NaN` would slip through both range comparisons as `false` and
 * `Infinity` would fail them for the wrong reason.
 *
 * Declared after the class rather than before it because it is a function
 * declaration and therefore hoisted — the TDZ hazard that forces the
 * `MIN_*`/`MAX_*` `const`s above the class does not apply to it.
 */
function readMultiplier(raw: unknown, field: string, min: number, max: number): number {
  if (raw === undefined) {
    return 1.0;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max) {
    return raw;
  }
  throw new InvalidValueObjectException(
    `tts configuration.${field} must be a number ${min}..${max}, got '${String(raw)}'`,
  );
}
