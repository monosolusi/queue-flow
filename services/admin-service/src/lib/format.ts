/**
 * Shared display formatters for the admin-service UI (FR-ADM-03). Kept framework-
 * free and side-effect-free so both the analytics page and its chart component
 * share one definition of "how a duration renders" (DRY — the chart's value
 * labels must match the table's `Rata Waktu` cells exactly).
 */

/** Formats a millisecond duration as seconds with one decimal (e.g. `30.0 s`). */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}