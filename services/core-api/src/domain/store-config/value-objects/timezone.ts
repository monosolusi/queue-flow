/**
 * Pure IANA timezone validation + default (QUE-42 / NFR-SEC-02). Mirrors the
 * client-side `admin-service/src/lib/timezone.ts` (`BROWSER_TIMEZONE` /
 * `TIMEZONE_OPTIONS`) so the backend `DailyResetPolicy` value object rejects,
 * at construction, any timezone the boot-time / re-arm `CronJob` would reject —
 * defense-in-depth so a direct API call that bypasses the client guard cannot
 * persist a TZ that crashes the scheduler (the `cron` library throws on an
 * unknown IANA name in the `CronJob` constructor).
 *
 * This is a pure domain helper: no framework, no I/O — it uses only the
 * built-in `Intl` object, so domain purity (NFR-MNT-01) holds. The helper
 * returns a boolean / default string; the value object that calls it throws
 * `InvalidValueObjectException` on a `false` result (it is not this helper's
 * job to raise or to format UI messages — the client helper owns the
 * Indonesian UI surface, this one owns the yes/no domain decision). Localized
 * duplication of `admin-service/src/lib/timezone.ts` is intentional: the two
 * packages are separate build trees (backend domain vs frontend bundle) on
 * either side of a TS/runtime boundary, and sharing a single validator across
 * that boundary would cross-couple them for one small pure function — the
 * mirror framing is preferred over a shared package.
 *
 * Node 20 ships full-ICU so IANA names resolve at runtime; a stripped-down
 * `small-icu` build would throw on `Intl.DateTimeFormat('en-US', { timeZone:
 * 'Asia/Jakarta' })`, but the QMS single-host deployment (NFR-MNT-02) uses the
 * official `node:20-alpine` image which carries full ICU.
 */

/**
 * The server's local IANA timezone, detected once at module load. Used as the
 * `DailyResetPolicy` default when a payload omits `timezone` (mirrors the
 * client `BROWSER_TIMEZONE` default — the single on-premise box's browser TZ
 * is the server's TZ, NFR-SEC-01). `Intl` is a built-in, so this import keeps
 * the domain dependency-free.
 */
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * @returns `true` when `tz` is a valid IANA timezone name accepted by
 *   `Intl.DateTimeFormat` (e.g. `'Asia/Jakarta'`, `'America/New_York'`,
 *   `'UTC'`). `false` for empty / unknown names. Implemented via a
 *   `try/catch` around `Intl.DateTimeFormat('en-US', { timeZone: tz })`
 *   because `Intl` throws `RangeError` on an unknown zone — there is no
 *   boolean-returning probe in the standard API.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.trim() === '') return false;
  try {
    // `en-US` locale is arbitrary; we only need to know whether `timeZone`
    // resolves. We never format the result.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}