/**
 * Range selector for `/admin/analytics` (FR-ADM-03). A `role="group"` cluster
 * of `aria-pressed` toggle buttons: the four quick relative-range presets
 * ("the last N days" — 7 / 14 / 30 / 90) plus a "Kustom" button that reveals
 * the manual Dari/Sampai date-range fields.
 *
 * The 90-day preset mirrors the backend `GetRangeReportUseCase.MAX_RANGE_DAYS`
 * cap; a longer preset would always 400.
 *
 * Pure presentational (SRP — no state of its own). The page owns the
 * `customMode` flag + the `from`/`to` values and threads `activeDays` (derived
 * from `from`/`to`) and `customMode` back in. The ARIA state IS the selector —
 * there is no `--active` modifier class, so the visual and the announced state
 * cannot drift apart (mirrors the `.timefield__option` idiom in `styles.css`).
 * Each button carries a stable `data-testid` so the page tests can drive a
 * click without hardcoding label text.
 *
 * Why an explicit `customMode` flag rather than deriving "custom" purely from
 * `from`/`to`? The date-range fields are hidden by default and only revealed
 * on an explicit "Kustom" tap, so the reveal is an orthogonal UI mode — NOT a
 * duplicate of the range value. A preset stays "pressed" only while NOT in
 * custom mode (a range that coincidentally matches a preset while the manager
 * is hand-editing must not flip the mode back). This mirrors the
 * derive-from-page-state rule (the page's `customMode` IS page state) without
 * introducing a parallel `preset: number | null` that would duplicate
 * `from`/`to` and drift.
 */
export const RELATIVE_PRESETS = [
  { label: '7 hari', days: 7 },
  { label: '14 hari', days: 14 },
  { label: '30 hari', days: 30 },
  { label: '90 hari', days: 90 },
] as const;

export function RelativeRangePicker({
  activeDays,
  customMode,
  onSelect,
  onSelectCustom,
}: {
  /** Which preset is currently active, or `null` when the range is custom.
   *  Only consulted when `customMode` is false (a preset is "pressed" iff the
   *  manager is on a preset AND its range matches). */
  activeDays: number | null;
  /** Whether the custom date-range panel is open. While true, NO preset is
   *  pressed (the manager is hand-editing) and the "Kustom" button is pressed. */
  customMode: boolean;
  /** Fired with `preset.days` when a preset button is clicked. */
  onSelect: (days: number) => void;
  /** Fired when the "Kustom" button is clicked (reveals the date fields). */
  onSelectCustom: () => void;
}) {
  return (
    <div className="relative-range" role="group" aria-label="Rentang relatif">
      {RELATIVE_PRESETS.map((p) => (
        <button
          key={p.days}
          type="button"
          className="btn relative-range__btn"
          aria-pressed={!customMode && activeDays === p.days}
          data-testid={`relative-range-${p.days}`}
          onClick={() => onSelect(p.days)}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        className="btn relative-range__btn"
        aria-pressed={customMode}
        data-testid="relative-range-custom"
        onClick={onSelectCustom}
      >
        Kustom
      </button>
    </div>
  );
}