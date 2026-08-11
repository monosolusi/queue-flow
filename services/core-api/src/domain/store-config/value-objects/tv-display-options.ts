import { InvalidValueObjectException } from '../../shared/errors';
import { ValueObject } from '../../shared/value-object';

/**
 * The five TV-display panels a manager can show/hide independently. The keys
 * are stable wire identifiers — the friendly display names live in the admin
 * client (`TV_DISPLAY_OPTION_LABELS`), never here.
 */
export type TvDisplayOptionKey =
  | 'showNowServing'
  | 'showWaitingQueue'
  | 'showCallHistory'
  | 'showCountersServing'
  | 'showRunningText';

/** The persisted shape: one boolean visibility toggle per panel. */
export type TvDisplayOptionsMap = Record<TvDisplayOptionKey, boolean>;

export const TV_DISPLAY_OPTION_KEYS: readonly TvDisplayOptionKey[] = [
  'showNowServing',
  'showWaitingQueue',
  'showCallHistory',
  'showCountersServing',
  'showRunningText',
];

/**
 * Per-panel visibility toggles for the TV display, persisted on
 * {@link SystemConfiguration} as a JSONB map column (the
 * `service_themes` / `daily_reset_policy` nested-VO precedent, not the scalar
 * `brand_color` column — a panel→boolean map is a nested value object). The TV
 * fetches `GET /api/system/config` at boot, reads the map, and gates each
 * panel render on its toggle (all-visible is the default, so a store that
 * never configures this keeps the existing TV layout — zero visual regression,
 * mirroring `ServiceThemes`).
 *
 * `of()` is permissive on *missing* keys (a missing key defaults to `true`) so
 * a reconstituted row from before this column existed, or a defensively-empty
 * column, recovers to all-visible without a migration. It is strict only on
 * *present* keys: a present key with a non-boolean value throws
 * `InvalidValueObjectException` (→ HTTP 400) so a malformed PUT fails fast
 * (NFR-REL-02 — no illegal toggle burns a write). A non-object `raw` (e.g.
 * the boot window `undefined` before the column exists, or a JSON `null`)
 * also recovers to all-visible rather than throwing, matching
 * `ServiceThemes.of(row.service_themes ?? undefined)` defensive reconstitution.
 *
 * Not change-gated for audit — `tvDisplayOptions` is an appearance concern,
 * like `brandColor`/`serviceThemes`, and is not in the NFR-SEC-02 audited list
 * (manual reset, state-schema, routing). `equals` is inherited (structural
 * deep-equal) and available if a future ticket adds display-options-change
 * diff-audit.
 */
export class TvDisplayOptions extends ValueObject<TvDisplayOptionsMap> {
  private constructor(map: TvDisplayOptionsMap) {
    super(map);
  }

  public static of(raw: unknown): TvDisplayOptions {
    // Non-object (undefined/null from the pre-migration boot window or a JSON
    // null) → all-visible default. A present-but-wrong-shape value (string,
    // array, number) is a malformed PUT → reject.
    if (raw === undefined || raw === null) {
      return TvDisplayOptions.DEFAULT;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidValueObjectException(
        `tv display options must be an object, got '${String(raw)}'`,
      );
    }
    const incoming = raw as Record<string, unknown>;
    const map = {} as TvDisplayOptionsMap;
    for (const key of TV_DISPLAY_OPTION_KEYS) {
      const value = incoming[key];
      if (value === undefined || value === null) {
        map[key] = true;
      } else if (typeof value === 'boolean') {
        map[key] = value;
      } else {
        throw new InvalidValueObjectException(
          `tv display option '${key}' must be a boolean, got '${String(value)}'`,
        );
      }
    }
    return new TvDisplayOptions(map);
  }

  /** All-visible — the PRD default so a store that never configures this keeps
   * the existing TV layout. Matches `ServiceThemes.DEFAULT` for zero visual
   * regression. */
  public static DEFAULT: TvDisplayOptions = TvDisplayOptions.of({
    showNowServing: true,
    showWaitingQueue: true,
    showCallHistory: true,
    showCountersServing: true,
    showRunningText: true,
  });

  public get options(): TvDisplayOptionsMap {
    return this.props;
  }

  public toDto(): TvDisplayOptionsMap {
    return { ...this.props };
  }

  public toString(): string {
    return JSON.stringify(this.props);
  }
}