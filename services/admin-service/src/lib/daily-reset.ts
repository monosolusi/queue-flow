/**
 * Time ↔ cron derivation for the daily-reset "automatic" mode (FR-WZD-05 /
 * QUE-34). The manager picks a reset time of day with the repo's `TimeField`
 * (a buffered `HH:MM` text input plus a Jam/Menit popover); this helper derives
 * the 5-field cron the backend `DailyResetPolicy` / `validateCronExpression`
 * expect, and parses a daily cron back into `HH:MM` for prefill. This replaces
 * the old raw-cron text input so the manager never types cron jargon (AC3).
 *
 * The buffering matters to this file: `timeToCron` falls back to `'0 0 * * *'`
 * on anything malformed, so `TimeField` withholds `onChange` until the typed
 * value is complete — otherwise every intermediate keystroke would round-trip
 * through here and snap the field to midnight.
 *
 * A 5-field cron is `minute hour day-of-month month day-of-week`. "Every day
 * at HH:MM" is therefore `MM HH * * *` — the PRD §7 default `0 0 * * *` is
 * midnight (`00:00`). (The QUE-34 ticket literal `0 M H * * *` is a typo —
 * that would be six tokens; the correct mapping is minute-then-hour.)
 *
 * Only "every day at a single time" is expressible here. More granular
 * schedules (e.g. twice daily) are deferred per the ticket notes; `cronToTime`
 * returns `null` for such crons so the call site can fall back to `00:00`
 * while preserving the raw cron in the form until the manager picks a time.
 */

/** `HH:MM` → `MM HH * * *`. Empty/invalid input falls back to midnight. */
export function timeToCron(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(hhmm.trim());
  if (!m) return '0 0 * * *';
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '0 0 * * *';
  return `${minute} ${hour} * * *`;
}

/**
 * `MM HH * * *` → `HH:MM` (zero-padded). Returns `null` when the cron is not a
 * single-time daily cron (minute + hour are single numbers, the last three
 * fields are all `*`); the call site then falls back to `00:00` and keeps the
 * raw cron in the form so a granular cron set via direct API is not silently
 * coerced.
 */
export function cronToTime(cron: string): string | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, mon, dow] = fields;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const h = Number(hour);
  const mi = Number(minute);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}