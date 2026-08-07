import { DEFAULT_SERVICE_THEMES, type ServiceSurface, type ServiceThemesMap } from '../api/types';

/** The four deployable surfaces, in stable display order (matches the admin
 *  panel section's row order and the backend `SERVICE_SURFACES`). */
export const SERVICE_SURFACES: readonly ServiceSurface[] = ['kiosk', 'tv', 'caller', 'admin'];

/**
 * Client-side per-service theme validation (QUE-47). The admin panel renders
 * one constrained `<select>` per surface (`light` / `dark`), so an invalid
 * value is not constructable through the UI — but a direct API prefill (or a
 * corrupt GET) could carry an unknown value. This guard mirrors the
 * UI-reachable subset of the backend `ServiceThemes` value object
 * (`core-api`'s `domain/store-config/value-objects/service-themes.ts`): each
 * of the 4 surfaces present with `'light'` or `'dark'`. The backend VO is
 * permissive on *missing* surfaces (defaults to light); this client guard is
 * strict on *presence* because the admin form always sends all 4 (the selects
 * always have a value). The two grammars stay in lock-step for the
 * UI-reachable subset; a divergence is a bug (QUE-34 mirroring rule).
 */

/**
 * @returns a list of Indonesian error strings for `map`; empty when valid
 * (mirrors `validateBrandColor`'s `string[]` contract — empty = valid).
 */
export function validateServiceThemes(map: ServiceThemesMap): string[] {
  const errors: string[] = [];
  for (const surface of SERVICE_SURFACES) {
    const value = map[surface];
    if (value !== 'light' && value !== 'dark') {
      errors.push(`Tema untuk ${surface} harus 'light' atau 'dark'.`);
    }
  }
  return errors;
}

/** True when `map` has a valid `light`/`dark` value for every surface. */
export function isValidServiceThemes(map: ServiceThemesMap): boolean {
  return validateServiceThemes(map).length === 0;
}

/**
 * Coerces an untrusted/partial `serviceThemes` from a GET projection into a
 * complete {@link ServiceThemesMap}, defaulting an unknown/missing surface to
 * `'light'` (the CSS `:root` default — no FOUC, mirrors the backend VO's
 * permissive reconstitution). Used at `toForm` so the form always carries a
 * complete 4-surface map even if the server returned a degraded shape.
 */
export function coerceServiceThemes(raw: Partial<Record<ServiceSurface, string>> | undefined | null): ServiceThemesMap {
  if (!raw) return { ...DEFAULT_SERVICE_THEMES };
  const out = { ...DEFAULT_SERVICE_THEMES };
  for (const surface of SERVICE_SURFACES) {
    const v = raw[surface];
    if (v === 'light' || v === 'dark') out[surface] = v;
  }
  return out;
}