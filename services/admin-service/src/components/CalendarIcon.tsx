/**
 * Decorative calendar glyph — hand-rolled inline SVG, no icon library
 * (NFR-REL-01: no CDN/remote asset at runtime). Shared by `DateField` (single
 * day) and `DateRangeField` (range) so the two controls present the same visual
 * affordance without duplicating the markup.
 *
 * `aria-hidden` + `focusable={false}` keep it out of the a11y tree — the
 * surrounding button carries the accessible name (`Buka kalender …`), so the
 * glyph must not be announced again.
 */
export function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable={false}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={3} y={5} width={18} height={16} rx={2} />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}