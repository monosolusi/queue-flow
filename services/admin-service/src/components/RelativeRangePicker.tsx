/**
 * Quick relative-range presets for `/admin/analytics` (FR-ADM-03). A
 * `role="group"` cluster of `aria-pressed` toggle buttons the manager taps to
 * jump the range to "the last N days" — 7 / 14 / 30 / 90 — without typing dates.
 *
 * The 90-day preset mirrors the backend `GetRangeReportUseCase.MAX_RANGE_DAYS`
 * cap; a longer preset would always 400.
 *
 * Pure presentational (SRP — no state of its own; the page derives the active
 * preset from its `from`/`to` and threads `activeDays` back in). The ARIA state
 * IS the selector — there is no `--active` modifier class, so the visual and
 * the announced state cannot drift apart (mirrors the `.timefield__option`
 * idiom in `styles.css`). Each button carries a stable `data-testid` derived
 * from `days` so the page tests can drive a preset click without hardcoding
 * label text.
 */
export const RELATIVE_PRESETS = [
  { label: '7 hari', days: 7 },
  { label: '14 hari', days: 14 },
  { label: '30 hari', days: 30 },
  { label: '90 hari', days: 90 },
] as const;

export function RelativeRangePicker({
  activeDays,
  onSelect,
}: {
  /** Which preset is currently active, or `null` when the range is custom. */
  activeDays: number | null;
  /** Fired with `preset.days` when a preset button is clicked. */
  onSelect: (days: number) => void;
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
    </div>
  );
}