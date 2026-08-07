/**
 * Shared display formatters for the admin-service UI (FR-ADM-03). Kept framework-
 * free and side-effect-free so both the analytics page tiles and its tables
 * share one definition of "how a duration renders" (DRY — a metric tile must
 * match the matching table cell exactly).
 */

/**
 * Formats a millisecond duration using the largest whole Indonesian unit so
 * averages spanning seconds → hours stay legible on the analytics page
 * (FR-ADM-03). One decimal place consistently.
 *
 * - `< 60 s` → `X.X detik`   (e.g. `12000` → `12.0 detik`)
 * - `< 60 min` → `X.X menit` (e.g. `90000` → `1.5 menit`)
 * - otherwise → `X.X jam`      (e.g. `3600000` → `1.0 jam`)
 * - `0` → `0.0 detik`
 *
 * Thresholds compare the **rounded** value (not the raw `ms`) so a duration
 * just below a threshold that rounds up to the next unit renders in that unit
 * — e.g. `59999ms` (59.999s → `60.0`) renders as `1.0 menit`, not `60.0 detik`,
 * keeping the display continuous across unit boundaries (no `60.0 detik` →
 * `1.0 menit` flip on a 1ms difference).
 *
 * Indonesian unit names per the PRD language convention (Bahasa Indonesia with
 * English technical terms). The `.xlsx` export (`export-range-report`) keeps
 * raw `ms` values with `(ms)` column headers — this formatter is display-only.
 */
export function formatDuration(ms: number): string {
  const seconds = Number((ms / 1000).toFixed(1));
  if (seconds < 60) return `${seconds.toFixed(1)} detik`;
  const minutes = Number((ms / 60_000).toFixed(1));
  if (minutes < 60) return `${minutes.toFixed(1)} menit`;
  return `${(ms / 3_600_000).toFixed(1)} jam`;
}