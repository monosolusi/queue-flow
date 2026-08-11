/**
 * `HH:MM` time-of-day parsing for {@link TimeField} — the time sibling of
 * `lib/date.ts`.
 *
 * The daily-reset control is the only time input in the panel and it round-trips
 * through `timeToCron` (`lib/daily-reset.ts`), which falls back to midnight on
 * anything malformed. So the field must be able to tell a *complete* value from
 * a half-typed one and withhold the former's neighbours: `normalizeTimeInput`
 * returning `null` is what keeps `"8:3"` from being committed as 08:03 and then
 * snapping the field to 00:00 on the next keystroke.
 *
 * The cron grammar itself lives in `lib/cron.ts` and stays untouched — it must
 * remain in lock-step with the backend `CronExpression` value object.
 */

/**
 * Normalizes a typed time to `HH:MM`, or `null` when it is not a complete,
 * in-range time.
 *
 * The minute **must** be two digits: while typing "08:30" the intermediate
 * "08:3" would otherwise normalize to 08:03 and commit a value the manager
 * never meant. The hour may be one or two digits (`8:30` → `08:30`) because a
 * one-digit hour is already unambiguous.
 */
export function normalizeTimeInput(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Whether `s` is already a complete, in-range time of day. */
export function isTimeValue(s: string): boolean {
  return normalizeTimeInput(s) !== null;
}
