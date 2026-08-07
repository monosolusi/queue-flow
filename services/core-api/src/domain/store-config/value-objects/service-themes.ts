import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The four deployable frontend surfaces a manager can theme independently.
 * Kiosk and TV are public (no login); caller and admin are authenticated.
 * The keys are stable wire identifiers — the friendly display names live in
 * the admin client (`SERVICE_SURFACE_LABELS`), never here.
 */
export type ServiceSurface = 'kiosk' | 'tv' | 'caller' | 'admin';

/** A per-surface light/dark choice. Light is the default (PRD §7 QUE-47). */
export type ThemeMode = 'light' | 'dark';

/** The persisted shape: one {@link ThemeMode} per {@link ServiceSurface}. */
export type ServiceThemesMap = Record<ServiceSurface, ThemeMode>;

export const SERVICE_SURFACES: readonly ServiceSurface[] = ['kiosk', 'tv', 'caller', 'admin'];

/**
 * Per-service light/dark theme preference, persisted on
 * {@link SystemConfiguration} (QUE-47) as a JSONB map column (the
 * `daily_reset_policy` nested-VO precedent, not the scalar `brand_color`
 * column — a service→theme map is a nested value object). Each frontend
 * fetches `GET /api/system/config` at boot, reads its own surface key, and
 * applies a `[data-theme="dark"]` attribute (light is the CSS `:root` default,
 * applied by omission — no FOUC for the default case, mirroring `BrandColor`).
 *
 * `of()` is permissive on *missing* surfaces (a missing key defaults to
 * `'light'`) so a reconstituted row from before a surface existed, or a
 * defensively-empty column, recovers to all-light without a migration. It is
 * strict only on *present* surfaces: a present key with a non-`light`/`dark`
 * value throws `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT
 * fails fast (NFR-REL-02 — no illegal theme burns a write). A non-object
 * `raw` (e.g. the boot window `undefined` before the column exists, or a JSON
 * `null`) also recovers to all-light rather than throwing, matching
 * `BrandColor.of(row.brand_color ?? DEFAULT)` defensive reconstitution.
 *
 * Not change-gated for audit — `serviceThemes` is an appearance concern, like
 * `brandColor`, and is not in the NFR-SEC-02 audited list (manual reset,
 * state-schema, routing). `equals` is inherited (structural deep-equal) and
 * available if a future ticket adds theme-change diff-audit.
 */
export class ServiceThemes extends ValueObject<ServiceThemesMap> {
  private constructor(map: ServiceThemesMap) {
    super(map);
  }

  public static of(raw: unknown): ServiceThemes {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → all-light default. A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return ServiceThemes.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `service themes must be an object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map = {} as ServiceThemesMap;
    for (const surface of SERVICE_SURFACES) {
      const value = incoming[surface];
      if (value === undefined || value === null) {
        map[surface] = 'light';
      } else if (value === 'light' || value === 'dark') {
        map[surface] = value;
      } else {
        throw new InvalidValueObjectException(
          `service theme for '${surface}' must be 'light' or 'dark', got '${String(value)}'`,
        );
      }
    }
    return new ServiceThemes(map);
  }

  /** All-light — the PRD §7 default and the CSS `:root` default, so a store
   * that never configures themes keeps the existing light look. Matches
   * `BrandColor.DEFAULT` for zero visual regression. */
  public static DEFAULT: ServiceThemes = ServiceThemes.of({
    kiosk: 'light',
    tv: 'light',
    caller: 'light',
    admin: 'light',
  });

  public get themes(): ServiceThemesMap {
    return this.props;
  }

  public toDto(): ServiceThemesMap {
    return { ...this.props };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}