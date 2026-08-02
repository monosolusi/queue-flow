/**
 * Local-date helpers shared across bounded contexts (QUE-26).
 *
 * The system is a single on-premise box (NFR-SEC-01), so every daily boundary —
 * the per-day ticket sequence key, the daily-reset archive threshold, the
 * reporting day window — is the store's *local* date, never UTC. These pure
 * helpers own that convention once, in the application layer, so the date
 * convention stays out of the pure domain model (NFR-MNT-01) and is unit-
 * testable via an injected clock. `Date` is a language builtin, not an I/O
 * library, so layer purity holds.
 *
 * Lives in `application/shared` (not `application/queue`) so a reporting or
 * audit consumer does not have to reach across into the queue bounded context
 * for a date utility (anti-corruption). Queue-context consumers re-export
 * these from `application/queue/create-ticket.use-case` for backward
 * compatibility.
 */

/**
 * Formats an epoch-ms timestamp as a local `YYYY-MM-DD` date key. The daily
 * sequence boundary is the store's local date (single on-premise box,
 * NFR-SEC-01), not UTC.
 */
export function toDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The epoch-ms timestamp of local midnight (00:00:00.000) on the day that
 * contains `epochMs`. Used by the daily-reset archive step (QUE-16) as the
 * threshold that separates "today" (kept in the active tickets store) from
 * "previous days" (relocated to the archive store).
 */
export function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * The epoch-ms timestamp of local midnight starting the day described by a
 * `YYYY-MM-DD` date key (the inverse direction of {@link toDateKey} — from a
 * key, not an epoch). Used by the reporting read side to turn the report's
 * `date` argument into the `[dayStart, dayStart + 1 day)` window it scans.
 * Parsing a date *key* (not an epoch) keeps the report repos free of their own
 * date-convention duplication.
 */
export function startOfLocalDayFromKey(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}