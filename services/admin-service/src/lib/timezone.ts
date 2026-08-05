/**
 * Timezone selection helpers for the wizard / admin daily-reset policy
 * (FR-WZD-05 / QUE-42). Mirrors the backend domain helper
 * `core-api/src/domain/store-config/value-objects/timezone.ts`
 * (`DEFAULT_TIMEZONE` / `isValidTimezone`) so the client and the backend share
 * the same IANA-timezone grammar — the raw IANA name is the `value=` on the
 * wire (matching the QUE-34 "enum stays as value=" precedent), never a
 * friendly label.
 *
 * The manager picks a timezone from a constrained `<select>` (no free-form
 * input) so an invalid IANA name is unconstructable on the client (mirrors the
 * QUE-34 constrained-`<select>` rule). The backend re-validates at
 * construction (defense-in-depth: a direct API call bypassing the client must
 * not persist a TZ that crashes the scheduler).
 *
 * Localized duplication of the backend helper is intentional: the two packages
 * are separate build trees (backend domain vs frontend bundle) on either side
 * of a TS/runtime boundary, and sharing a single validator across that
 * boundary would cross-couple them for one small pure function — the mirror
 * framing (and the failing-test drift signal) is preferred over a shared
 * package. The two grammars MUST stay in lock-step; a divergence is a bug.
 */

/**
 * The browser's local IANA timezone, detected once at module load. The single
 * on-premise box's browser TZ is the server's TZ (NFR-SEC-01), so this is the
 * default the wizard prefills and the value the backend `DailyResetPolicy`
 * defaults to when a payload omits `timezone`.
 */
export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * A curated, manager-friendly list of valid IANA timezone names — the Indonesia
 * WIB/WITA/WIT zones plus major world cities a manager is likely to pick. Kept
 * scannable (~15 entries) rather than the full ~400-name IANA list so the
 * dropdown is usable on a touch kiosk. The raw IANA name is the `value=` (wire
 * contract); the manager sees the name as-is (the browser-TZ default is
 * preselected, so the common case needs no scrolling).
 */
export const TIMEZONE_OPTIONS: readonly string[] = [
  'Asia/Jakarta', // WIB, UTC+07:00
  'Asia/Makassar', // WITA, UTC+08:00
  'Asia/Jayapura', // WIT, UTC+09:00
  'Asia/Pontianak', // WIB, UTC+07:00
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'Australia/Sydney',
  'UTC',
];

/**
 * Returns the timezone options for the `<select>`, with both the persisted TZ
 * (`savedTz`, the value the form currently holds — prefilled from
 * `config.dailyResetPolicy.timezone`) and the browser's detected IANA zone
 * uniquely prepended so the **default and the saved value are always
 * selectable**. Without `savedTz`, a direct-API call that persists a valid IANA
 * zone which is neither the browser's nor in `TIMEZONE_OPTIONS` (e.g.
 * `Asia/Kolkata`) would leave `<select value=...>` with no matching option —
 * React then renders the first option visually while the form holds the unseen
 * persisted value, so a save that never touched the select would silently send
 * a TZ the manager never saw (a "what you see ≠ what you send" contract gap).
 * Passing the form's current TZ makes the constrained-`<select>` contract
 * hold for any persisted value, not just the curated/browser ones. Dedupes so a
 * zone appearing in several sources is listed once. The raw IANA name is the
 * `value=`; the call site renders it verbatim as the `<option>` body (matching
 * the QUE-34 enum-as-value precedent).
 */
export function timezoneSelectOptions(savedTz?: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tz of [savedTz, BROWSER_TIMEZONE, ...TIMEZONE_OPTIONS]) {
    if (!tz || seen.has(tz)) continue;
    seen.add(tz);
    out.push(tz);
  }
  return out;
}