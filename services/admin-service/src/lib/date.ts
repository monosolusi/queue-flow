/**
 * The admin client's single owner of the `YYYY-MM-DD` **local-date** convention
 * — the frontend sibling of core-api's `src/application/shared/date.ts`.
 *
 * Local time, never UTC: the whole system runs on one on-premise box for one
 * store (NFR-SEC-01), so "today" means the store's civil day. A UTC-derived key
 * would roll over at the wrong moment for any store not on UTC and would make
 * the range/report keys disagree with the backend, which derives its keys the
 * same local way.
 *
 * These helpers were previously duplicated per page — `todayLocalKey` /
 * `daysAgoLocalKey` / a private `formatKey` in `AnalyticsPage`, `localDayKey`
 * in `AuditLogPage` — and `DateField` needs the `Date ⇄ key` conversion too,
 * which would have made a fourth copy. They are moved here verbatim; only
 * {@link isDateKey} and {@link parseDateKey} are new. Range/formatting
 * utilities deliberately stay out: nothing needs them, and the backend owns the
 * range semantics.
 */

/** A `Date` as the store's local `YYYY-MM-DD`. */
export function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's date as the store's local `YYYY-MM-DD`. */
export function todayLocalKey(): string {
  return formatDateKey(new Date());
}

/** `n` days before today as the store's local `YYYY-MM-DD`. */
export function daysAgoLocalKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatDateKey(d);
}

/** Local `YYYY-MM-DD` for an epoch-ms timestamp. */
export function localDayKey(ms: number): string {
  return formatDateKey(new Date(ms));
}

/** Whether `s` is a well-formed, real `YYYY-MM-DD` civil date. */
export function isDateKey(s: string): boolean {
  return parseDateKey(s) !== null;
}

/**
 * `YYYY-MM-DD` → a local `Date` at midnight, or `null` when the string is not a
 * real civil date.
 *
 * Built from local components (`new Date(y, m - 1, d)`) — **never**
 * `new Date('2026-01-01')`, which the spec parses as UTC midnight and would
 * shift the day backwards for any store west of Greenwich (NFR-SEC-01).
 *
 * The round-trip guard is what rejects impossible dates: JS rolls `2026-02-31`
 * over to March 3, so re-formatting the result and comparing it to the input is
 * the cheapest correct validity check.
 */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return formatDateKey(d) === key ? d : null;
}
