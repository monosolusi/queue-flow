/**
 * Range presets for `/admin/analytics` (FR-ADM-03). A `role="group"` cluster of
 * `aria-pressed` toggle buttons for the four quick relative-range windows
 * ("the last N days" — 7 / 14 / 30 / 90), followed by a "Kustom" toggle that
 * reveals the manual `DateRangeField` on the page (manager feedback: the
 * always-visible rentang tanggal was too wide and should only appear on custom).
 *
 * The 90-day preset mirrors the backend `GetRangeReportUseCase.MAX_RANGE_DAYS`
 * cap; a longer preset would always 400.
 *
 * Pure presentational (SRP — no state of its own). The page owns the
 * `from`/`to` values + the `customActive` flag and threads `activeDays` (derived
 * from `from`/`to`, but suppressed to `null` while custom is active so no preset
 * shows pressed alongside "Kustom") back in. The ARIA state IS the selector —
 * there is no `--active` modifier class, so the visual and the announced state
 * cannot drift apart (mirrors the `.timefield__option` idiom in `styles.css`).
 * Each button carries a stable `data-testid` so the page tests can drive a click
 * without hardcoding label text.
 */
export const RELATIVE_PRESETS = [
  { label: '7 hari', days: 7 },
  { label: '14 hari', days: 14 },
  { label: '30 hari', days: 30 },
  { label: '90 hari', days: 90 },
] as const;

export function RelativeRangePicker({
  activeDays,
  customActive = false,
  onSelect,
  onSelectCustom,
}: {
  /** Which preset is currently active, or `null` when the range does not match
   *  any preset (a hand-picked range that is not the last N days, or any range
   *  while custom mode is active — the page suppresses the match to `null`). */
  activeDays: number | null;
  /** Whether the manual `DateRangeField` is currently revealed (the "Kustom"
   *  button is pressed). While true the page passes `activeDays={null}` so no
   *  preset shows pressed alongside it. */
  customActive?: boolean;
  /** Fired with `preset.days` when a preset button is clicked. */
  onSelect: (days: number) => void;
  /** Fired when the "Kustom" toggle is clicked (reveals the manual range). */
  onSelectCustom?: () => void;
}) {
  return (
    <div className="relative-range" role="group" aria-label="Rentang relatif">
      {RELATIVE_PRESETS.map((p) => (
        <button
          key={p.days}
          type="button"
          className="btn relative-range__btn"
          aria-pressed={activeDays === p.days}
          data-testid={`relative-range-${p.days}`}
          onClick={() => onSelect(p.days)}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        className="btn relative-range__btn"
        aria-pressed={customActive}
        data-testid="relative-range-custom"
        onClick={() => onSelectCustom?.()}
      >
        Kustom
      </button>
    </div>
  );
}