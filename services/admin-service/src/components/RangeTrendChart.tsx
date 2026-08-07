import type { DailyPointDto } from '../api/types';

/**
 * The range trend chart (FR-ADM-03 / QUE-44): one vertical bar per day, height
 * = that day's total visitors, drawn as hand-rolled offline SVG (no chart
 * library, NFR-REL-01 — mirrors the hand-rolled offline-SVG `RoutingGraph`
 * precedent).
 * Pure presentational: fed entirely by the {@link RangeReportDto} `perDay`
 * slice the page already loaded; no API, realtime, or state of its own (SRP),
 * and it consumes no admin/reporting DTO beyond that slice (ISP).
 *
 * Single-series magnitude over time → one accent hue (`--accent`) for every bar;
 * the bar height encodes the value, the date labels the day. The SVG's
 * accessible name + per-bar `<title>` carry the values for AT/tooltip; the
 * sibling "Per Hari" table (on the analytics page) is the always-available table
 * view. Days with zero visitors render as a 1px baseline tick so the axis stays
 * continuous (the backend materializes zero-point rows for empty days).
 *
 * Returns `null` when `perDay` is empty so a stray empty card never appears (the
 * page-level guard short-circuits first; this is the defensive backstop).
 */

// SVG geometry (viewBox user units). The svg scales to its container via
// `width:100%`; bars sit on a common baseline with date labels beneath.
// QUE-51 — widened so per-bar value labels never collide with the bar tops or
// each other; rounded bar tops + subtle gridlines for a cleaner modern feel.
const SLOT = 46; // per-day column width (bar + gap)
const BAR_W = 30; // bar mark width (roomier than the prior 22)
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 24; // room for the max value label above the tallest bar
const PAD_BOTTOM = 24; // room for the date labels
const PLOT_H = 150; // bar plot height
const CHART_H = PAD_TOP + PLOT_H + PAD_BOTTOM;
const BASELINE = PAD_TOP + PLOT_H;

/** `YYYY-MM-DD` → `MM-DD` (compact axis label, no year on every tick). */
function shortDate(dateKey: string): string {
  return dateKey.slice(5);
}

export function RangeTrendChart({ perDay }: { perDay: readonly DailyPointDto[] }) {
  if (perDay.length === 0) return null;

  const values = perDay.map((p) => p.totalTickets);
  const max = Math.max(1, ...values);
  const chartW = PAD_LEFT + perDay.length * SLOT + PAD_RIGHT;
  // Render a value label above each bar only when there are few enough days that
  // they won't collide; for long ranges the per-bar <title> carries the value.
  const showValueLabels = perDay.length <= 10;
  // Sparse date ticks for long ranges so labels never overlap.
  const labelStep = Math.max(1, Math.ceil(perDay.length / 12));
  // Short ranges: the accessible name lists every day's value. Long ranges: a
  // one-line summary (a 90-entry aria-label is a wall of text for AT) — the
  // per-bar <title> stays the granular channel for each day.
  const summary =
    perDay.length <= 12
      ? `Total pengunjung per hari: ${perDay.map((p) => `${p.date}: ${p.totalTickets}`).join(', ')}`
      : `Total pengunjung per hari, ${perDay.length} hari (rentang ${perDay[0].date}–${perDay[perDay.length - 1].date})`;

  // Subtle horizontal gridlines at 25/50/75% of PLOT_H above the baseline for a
  // modern feel. Rendered BEFORE the bars so bars sit on top. No 0% gridline —
  // the baseline axis line already covers it.
  const gridlineYs = [
    BASELINE - 0.25 * PLOT_H,
    BASELINE - 0.5 * PLOT_H,
    BASELINE - 0.75 * PLOT_H,
  ];

  return (
    <section className="config-card" aria-label="Tren pengunjung">
      <h2 className="config-card__title">Tren Pengunjung</h2>
      <svg
        className="range-trend__svg"
        viewBox={`0 0 ${chartW} ${CHART_H}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
        data-testid="range-trend-chart"
      >
        {/* Subtle horizontal gridlines (rendered before bars so bars sit on top). */}
        {gridlineYs.map((y, i) => (
          <line
            key={i}
            className="range-trend__gridline"
            x1={PAD_LEFT}
            y1={y}
            x2={chartW - PAD_RIGHT}
            y2={y}
          />
        ))}
        {/* Baseline axis line. */}
        <line
          className="range-trend__axis"
          x1={PAD_LEFT}
          y1={BASELINE}
          x2={chartW - PAD_RIGHT}
          y2={BASELINE}
        />
        {perDay.map((p, i) => {
          const slotX = PAD_LEFT + i * SLOT;
          const barX = slotX + (SLOT - BAR_W) / 2;
          const h = (p.totalTickets / max) * PLOT_H;
          const barY = BASELINE - h;
          // Place the value label with a clear gap above the bar; the increased
          // PAD_TOP (24) gives the tallest bar's label room to fit without
          // clipping, so no headroom guard is needed (tests rely on labels
          // rendering for short ranges).
          const valueLabelY = barY - 6;
          return (
            <g key={p.date}>
              <rect
                className="range-trend__bar"
                data-testid={`range-trend-bar-${i}`}
                x={barX}
                y={barY}
                width={BAR_W}
                height={Math.max(h, p.totalTickets > 0 ? 2 : 1)}
                rx={5}
              >
                <title>{`${p.date}: ${p.totalTickets} pengunjung`}</title>
              </rect>
              {showValueLabels && p.totalTickets > 0 && (
                <text className="range-trend__value" x={slotX + SLOT / 2} y={valueLabelY} textAnchor="middle">
                  {p.totalTickets}
                </text>
              )}
              {i % labelStep === 0 && (
                <text
                  className="range-trend__date"
                  x={slotX + SLOT / 2}
                  y={CHART_H - 6}
                  textAnchor="middle"
                >
                  {shortDate(p.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}