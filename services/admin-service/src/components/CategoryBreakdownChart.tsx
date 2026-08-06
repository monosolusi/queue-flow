import type { CategoryBreakdownDto } from '../api/types';

/**
 * The per-category breakdown chart (FR-ADM-03 / QUE-46): one horizontal bar
 * per category, length = that category's total visitors over the range, drawn
 * as hand-rolled offline SVG (no chart library, NFR-REL-01 — mirrors the
 * hand-rolled offline-SVG `RangeTrendChart` / `RoutingGraph` precedent).
 * Pure presentational: fed entirely by the {@link RangeReportDto} `perCategory`
 * slice the page already loaded; no API, realtime, or state of its own (SRP),
 * and it consumes no admin/reporting DTO beyond that slice (ISP).
 *
 * **Horizontal layout is the non-overlap fix (QUE-48):** category names sit on
 * the Y-axis, one row per category, so each name gets its own line — no rotation,
 * no collision, regardless of how many categories or how long the names are (the
 * failing mode of the deleted vertical `RecapCharts`). Names longer than the
 * label column are truncated with an ellipsis; the full name + count is always
 * available in the per-row `<title>` (the granular a11y/tooltip channel). The
 * sibling "Per Kategori" table on the analytics page is the always-available
 * table view.
 *
 * Single-series magnitude → one accent hue (`--accent`) for every bar; the bar
 * length encodes the value, the category name labels the row. The SVG's
 * accessible name + per-bar `<title>` carry the values for AT/tooltip. Text
 * never wears the data hue (labels in `--text`/`--text-muted`).
 *
 * Returns `null` when `perCategory` is empty so a stray empty card never appears
 * (the page-level guard short-circuits first; this is the defensive backstop).
 */

// SVG geometry (viewBox user units). The svg scales to its container via
// `width:100%`; bars share a common left edge (the bar plot's x-origin) so
// lengths are comparable across rows.
const LABEL_W = 132; // name column width (right-aligned labels)
const LABEL_GAP = 8; // gutter between the name column and the bar plot
const BAR_X0 = LABEL_W + LABEL_GAP; // shared bar left edge
const ROW_H = 30; // per-row pitch (bar + breathing room — the no-overlap budget)
const BAR_H = 16; // bar thickness (centered in the row)
const PLOT_W = 176; // bar plot width (the max-value bar spans this)
const VALUE_GAP = 6; // gutter between a bar's end and its value label
const PAD_TOP = 4;
const PAD_BOTTOM = 6;
const CHART_W = BAR_X0 + PLOT_W + 56; // tail room for the max value label
/** Truncate a name longer than this many characters with an ellipsis. */
const MAX_NAME_CHARS = 20;

/**
 * Truncate `name` to `MAX_NAME_CHARS` with an ellipsis when it overflows. SVG
 * has no cheap text measurement, so this is a fixed **character** budget (not
 * pixel width): a run of narrow glyphs fits, a run of wide ones may truncate
 * slightly early. The trade-off is acceptable because the per-row `<title>`
 * always carries the full, untruncated name — no data is ever lost (the visible
 * label is a glance-friendly abbreviation, the title is the source of truth).
 */
function truncate(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
}

export function CategoryBreakdownChart({
  perCategory,
}: {
  perCategory: readonly CategoryBreakdownDto[];
}) {
  if (perCategory.length === 0) return null;

  // Sorted desc by total — the chart highlights the biggest categories at a
  // glance. This **intentionally diverges** from the sibling "Per Kategori"
  // table, which renders in backend (`c.code` ASC) order as the reference list.
  const rows = [...perCategory].sort((a, b) => b.totalTickets - a.totalTickets);
  const max = Math.max(1, ...rows.map((c) => c.totalTickets));
  const chartH = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;

  // Few categories: the accessible name lists every category: value. Many
  // categories: a one-line summary (a long aria-label is a wall of text for AT)
  // — the per-row <title> stays the granular channel. Mirrors the
  // `RangeTrendChart` >12-day collapse precedent; categories are configurable,
  // so the threshold guards a manager who configures many.
  const summary =
    rows.length <= 8
      ? `Total pengunjung per kategori: ${rows.map((c) => `${c.categoryName}: ${c.totalTickets}`).join(', ')}`
      : `Total pengunjung per kategori, ${rows.length} kategori. Terbanyak: ${rows[0].categoryName}: ${rows[0].totalTickets}`;

  return (
    <svg
      className="category-breakdown__svg"
      viewBox={`0 0 ${CHART_W} ${chartH}`}
      role="img"
      aria-label={summary}
      preserveAspectRatio="xMidYMid meet"
      data-testid="category-breakdown-chart"
    >
      {/* Baseline axis line at the shared bar left edge. */}
      <line
        className="category-breakdown__axis"
        x1={BAR_X0}
        y1={0}
        x2={BAR_X0}
        y2={chartH}
      />
      {rows.map((c, i) => {
        const rowY = PAD_TOP + i * ROW_H;
        const barY = rowY + (ROW_H - BAR_H) / 2;
        const barW = (c.totalTickets / max) * PLOT_W;
        const midY = rowY + ROW_H / 2;
        return (
          <g key={c.categoryId} data-testid={`category-breakdown-row-${i}`}>
            <title>{`${c.categoryName}: ${c.totalTickets} pengunjung`}</title>
            <text
              className="category-breakdown__label"
              x={LABEL_W - LABEL_GAP}
              y={midY}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {truncate(c.categoryName)}
            </text>
            <rect
              className="category-breakdown__bar"
              data-testid={`category-breakdown-bar-${i}`}
              x={BAR_X0}
              y={barY}
              width={Math.max(barW, c.totalTickets > 0 ? 2 : 1)}
              height={BAR_H}
              rx={2}
            />
            <text
              className="category-breakdown__value"
              x={BAR_X0 + Math.max(barW, c.totalTickets > 0 ? 2 : 1) + VALUE_GAP}
              y={midY}
              textAnchor="start"
              dominantBaseline="middle"
            >
              {c.totalTickets}
            </text>
          </g>
        );
      })}
    </svg>
  );
}