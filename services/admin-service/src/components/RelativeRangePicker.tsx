/**
 * Range presets for `/admin/analytics` (FR-ADM-03). A `role="group"` cluster of
 * `aria-pressed` toggle buttons for the four quick relative-range windows
 * ("the last N days" — 7 / 14 / 30 / 90).
 *
 * The 90-day preset mirrors the backend `GetRangeReportUseCase.MAX_RANGE_DAYS`
 * cap; a longer preset would always 400.
 *
 * Pure presentational (SRP — no state of its own). The page owns the
 * `from`/`to` values and threads `activeDays` (derived from `from`/`to`) back
 * in. The ARIA state IS the selector — there is no `--active` modifier class,
 * so the visual and the announced state cannot drift apart (mirrors the
 * `.timefield__option` idiom in `styles.css`). Each button carries a stable
 * `data-testid` so the page tests can drive a click without hardcoding label
 * text.
 *
 * The manual range is now ALWAYS visible on the page as a `DateRangeField`
 * (no reveal step) — the separate "Kustom" button that used to live here is
 * gone (manager feedback: "ada tombol kustom, tombol kalender dan textbox
 * terpisah" — unify into one grouped textbox). With no reveal step there is no
 * `customMode` flag: `activeDays` is always consulted, and a hand-picked range
 * that coincidentally matches a preset honestly shows that preset pressed
 * (cleaner than the prior `customMode` override that suppressed the match).
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
  /** Which preset is currently active, or `null` when the range does not match
   *  any preset (a hand-picked range that is not the last N days). */
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