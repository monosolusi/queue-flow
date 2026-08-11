import {
  DEFAULT_TV_DISPLAY_OPTIONS,
  TV_DISPLAY_OPTION_KEYS,
  type TvDisplayOptionKey,
  type TvDisplayOptionsMap,
} from '../api/types';

/**
 * Client-side TV-display-options validation. The admin panel renders one
 * constrained checkbox per panel, so an invalid value is not constructable
 * through the UI — but a direct API prefill (or a corrupt GET) could carry an
 * unknown key or a non-boolean. This guard mirrors the UI-reachable subset of
 * the backend `TvDisplayOptions` value object (`core-api`'s
 * `domain/store-config/value-objects/tv-display-options.ts`): each of the 5
 * keys present with a boolean. The backend VO is permissive on *missing* keys
 * (defaults to `true`); this client guard is strict on *presence* because the
 * admin form always sends all 5 (the checkboxes always have a value). The two
 * grammars stay in lock-step for the UI-reachable subset; a divergence is a
 * bug (QUE-34 mirroring rule).
 */

/**
 * @returns a list of Indonesian error strings for `map`; empty when valid
 * (mirrors `validateServiceThemes`'s `string[]` contract — empty = valid).
 */
export function validateTvDisplayOptions(map: TvDisplayOptionsMap): string[] {
  const errors: string[] = [];
  for (const key of TV_DISPLAY_OPTION_KEYS) {
    const value = map[key];
    if (typeof value !== 'boolean') {
      errors.push(`Pilihan tampilan TV '${key}' harus boolean (benar/salah).`);
    }
  }
  return errors;
}

/** True when `map` has a valid boolean value for every panel key. */
export function isValidTvDisplayOptions(map: TvDisplayOptionsMap): boolean {
  return validateTvDisplayOptions(map).length === 0;
}

/**
 * Coerces an untrusted/partial `tvDisplayOptions` from a GET projection into a
 * complete {@link TvDisplayOptionsMap}, defaulting an unknown/missing key to
 * `true` (the all-visible default — mirrors the backend VO's permissive
 * reconstitution). Used at `toForm` so the form always carries a complete
 * 5-key map even if the server returned a degraded shape.
 */
export function coerceTvDisplayOptions(
  raw: Partial<Record<TvDisplayOptionKey, boolean>> | undefined | null,
): TvDisplayOptionsMap {
  if (!raw) return { ...DEFAULT_TV_DISPLAY_OPTIONS };
  const out = { ...DEFAULT_TV_DISPLAY_OPTIONS };
  for (const key of TV_DISPLAY_OPTION_KEYS) {
    const v = raw[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}