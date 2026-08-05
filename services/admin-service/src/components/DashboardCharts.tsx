import type { DailyReportDto } from '../api/types';
import { formatSeconds } from '../lib/format';
import type { CounterRow } from '../lib/analytics-loader';

/**
 * The four Dashboard graphs (admin-service modernization / FR-ADM-03): hand-
 * rolled offline SVG (no chart library, NFR-REL-01 — mirrors the RecapCharts +
 * RoutingGraph precedent). Pure presentational: fed entirely by the
 * {@link DailyReportDto} + counter reads already loaded by the page; no API,
 * realtime, or state of its own (SRP), and it consumes no admin/reporting DTO
 * beyond what the page already loaded (ISP).
 *
 * Four charts:
 * 1. Total tiket per kategori — horizontal bars.
 * 2. Tiket dilayani per counter — horizontal bars.
 * 3. Distribusi kategori — donut (stroke-dasharray slices on one circle).
 * 4. Waktu tunggu vs layanan per kategori — paired horizontal bars.
 *
 * Each mark carries a `<title>` + `data-testid` so the charts are assertable
 * without a pixel diff (mirrors `RecapCharts`). Each `<svg>` is `role="img"`
 * with an `aria-label` summary carrying the formatted values for AT.
 */

// SVG geometry constants (viewBox user units). The svg scales to its container
// via `width:100%`; the value column is reserved so the tip label never clips.
const VIEW_W = 360;
const LABEL_X = 36; // left edge of the bar area (the code/counter label sits in 0..LABEL_X)
const VALUE_RESERVE = 64; // room for the tip value label
const BAR_AREA_W = VIEW_W - LABEL_X - VALUE_RESERVE; // 260
const BAR_H = 16; // ≤24 per the mark spec — thin marks, air around them
const ROW_GAP = 6; // surface shows through between rows
const PAD_TOP = 4;
const PAD_BOTTOM = 2;
const VALUE_PAD = 6; // gap between the bar tip and the value label

// Donut geometry (viewBox 100x100, circle r=40 → circumference C = 2π·40).
const DONUT_R = 40;
const DONUT_C = 2 * Math.PI * DONUT_R;
const DONUT_VIEW = 100;

// Up to 4 slice colors cycle through existing tokens (--accent / --success /
// --warn / --danger); a 5th+ slice cycles back to --accent. CSS variable refs
// keep the donut in lock-step with the runtime brand-color override on
// --accent (the first slice re-themes with the store).
const DONUT_COLORS = ['var(--accent)', 'var(--success)', 'var(--warn)', 'var(--danger)'];

function chartHeight(rows: number): number {
  return PAD_TOP + rows * BAR_H + (rows - 1) * ROW_GAP + PAD_BOTTOM;
}

interface BarRow {
  /** Display label (category code or counter name). */
  readonly code: string;
  /** testid suffix (category code or counterId — keeps ids free of spaces). */
  readonly id: string;
  readonly value: number;
  readonly formatted: string;
}

function barRows(
  items: readonly { code: string; id: string; value: number }[],
  format: (v: number) => string,
): BarRow[] {
  return items.map((it) => ({
    code: it.code,
    id: it.id,
    value: it.value,
    formatted: format(it.value),
  }));
}

function renderBars(
  rows: BarRow[],
  testidPrefix: string,
  fill: string,
): React.ReactNode {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r, i) => {
    const y = PAD_TOP + i * (BAR_H + ROW_GAP);
    const w = (r.value / max) * BAR_AREA_W;
    const labelY = y + BAR_H - 4; // baseline-centred for an ~11px font in a 16px bar
    return (
      <g key={r.id}>
        <text className="bar-chart__label" x={0} y={labelY}>
          {r.code}
        </text>
        <rect
          className="bar-chart__bar"
          data-testid={`${testidPrefix}-${r.id}`}
          x={LABEL_X}
          y={y}
          width={w}
          height={BAR_H}
          rx={3}
          style={{ fill }}
        >
          <title>{`${r.code}: ${r.formatted}`}</title>
        </rect>
        <text className="bar-chart__value" x={LABEL_X + w + VALUE_PAD} y={labelY}>
          {r.formatted}
        </text>
      </g>
    );
  });
}

/** A horizontal-bar figure (charts 1, 2, 4 use this primitive). */
function BarFigure({
  title,
  rows,
  testidPrefix,
  fill,
  summary,
}: {
  title: string;
  rows: BarRow[];
  testidPrefix: string;
  fill: string;
  summary: string;
}) {
  if (rows.length === 0) return null;
  const chartH = chartHeight(rows.length);
  return (
    <figure className="dash-chart">
      <figcaption className="dash-chart__title">{title}</figcaption>
      <svg
        className="dash-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${chartH}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {renderBars(rows, testidPrefix, fill)}
      </svg>
    </figure>
  );
}

/** The donut figure (chart 3). Renders a muted full ring + "0" center when total=0. */
function DonutFigure({
  report,
}: {
  report: DailyReportDto;
}) {
  const cats = report.perCategory;
  const total = report.totalTickets;
  const cx = DONUT_VIEW / 2;
  const cy = DONUT_VIEW / 2;

  if (cats.length === 0 || total === 0) {
    return (
      <figure className="dash-chart donut">
        <figcaption className="dash-chart__title">Distribusi Kategori</figcaption>
        <svg
          className="donut__svg"
          viewBox={`0 0 ${DONUT_VIEW} ${DONUT_VIEW}`}
          role="img"
          aria-label="Distribusi kategori: belum ada data"
          preserveAspectRatio="xMidYMid meet"
        >
          <circle
            cx={cx}
            cy={cy}
            r={DONUT_R}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={12}
          />
          <text
            className="donut__center"
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
          >
            0
          </text>
        </svg>
        <ul className="donut__legend">
          <li className="donut__legend-item donut__legend-item--muted">
            Belum ada tiket.
          </li>
        </ul>
      </figure>
    );
  }

  // Each slice is one circle with a stroke-dasharray of [sliceLen, C-sliceLen]
  // and a stroke-dashoffset that positions it after the cumulative previous
  // slices. rotate(-90) starts the first slice at 12 o'clock.
  let cumulative = 0;
  const summaryParts = cats.map((c) => {
    const pct = total > 0 ? (c.totalTickets / total) * 100 : 0;
    return `${c.code} ${c.totalTickets} (${pct.toFixed(0)}%)`;
  });
  const summary = `Distribusi kategori: ${summaryParts.join(', ')}`;

  return (
    <figure className="dash-chart donut">
      <figcaption className="dash-chart__title">Distribusi Kategori</figcaption>
      <svg
        className="donut__svg"
        viewBox={`0 0 ${DONUT_VIEW} ${DONUT_VIEW}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {cats.map((c, i) => {
            const fraction = c.totalTickets / total;
            const sliceLen = fraction * DONUT_C;
            const offset = -cumulative * DONUT_C;
            cumulative += fraction;
            const color = DONUT_COLORS[i % DONUT_COLORS.length];
            return (
              <circle
                key={c.categoryId}
                cx={cx}
                cy={cy}
                r={DONUT_R}
                fill="none"
                stroke={color}
                strokeWidth={12}
                strokeDasharray={`${sliceLen} ${DONUT_C - sliceLen}`}
                strokeDashoffset={offset}
                data-testid={`dashboard-donut-${c.code}`}
              >
                <title>{`${c.code}: ${c.totalTickets} (${((fraction * 100).toFixed(0))}%)`}</title>
              </circle>
            );
          })}
        </g>
        <text
          className="donut__center"
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {total}
        </text>
      </svg>
      <ul className="donut__legend">
        {cats.map((c, i) => (
          <li key={c.categoryId} className="donut__legend-item">
            <span
              className="donut__legend-swatch"
              style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
              aria-hidden="true"
            />
            <span className="donut__legend-label">{c.code}</span>
            <span className="donut__legend-count">{c.totalTickets}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * The paired wait-vs-service bar chart (chart 4). Two bars per category stacked
 * vertically (tunggu then layanan), each carrying its own testid so the two
 * metrics are independently assertable.
 */
function WaitServiceFigure({ report }: { report: DailyReportDto }) {
  const cats = report.perCategory;
  if (cats.length === 0) return null;

  // Two rows per category (tunggu, layanan) → doubled row count + an extra
  // gap between categories for visual grouping.
  const rowsPerCat = 2;
  const interCatGap = 4;
  const chartH =
    PAD_TOP + cats.length * (rowsPerCat * BAR_H + ROW_GAP) + (cats.length - 1) * interCatGap + PAD_BOTTOM;

  const maxWait = Math.max(1, ...cats.map((c) => c.avgWaitTimeMs));
  const maxService = Math.max(1, ...cats.map((c) => c.avgServiceTimeMs));
  const max = Math.max(maxWait, maxService);

  const summaryWait = cats
    .map((c) => `${c.code} ${formatSeconds(c.avgWaitTimeMs)}`)
    .join(', ');
  const summaryService = cats
    .map((c) => `${c.code} ${formatSeconds(c.avgServiceTimeMs)}`)
    .join(', ');
  const summary = `Waktu tunggu per kategori: ${summaryWait}. Waktu layanan per kategori: ${summaryService}.`;

  let cursor = PAD_TOP;
  return (
    <figure className="dash-chart">
      <figcaption className="dash-chart__title">Waktu Tunggu vs Layanan per Kategori</figcaption>
      <svg
        className="dash-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${chartH}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {cats.map((c) => {
          const waitY = cursor;
          const waitW = (c.avgWaitTimeMs / max) * BAR_AREA_W;
          const waitLabelY = waitY + BAR_H - 4;
          const serviceY = waitY + BAR_H + ROW_GAP;
          const serviceW = (c.avgServiceTimeMs / max) * BAR_AREA_W;
          const serviceLabelY = serviceY + BAR_H - 4;
          cursor = serviceY + BAR_H + ROW_GAP + interCatGap;
          return (
            <g key={c.categoryId}>
              <text className="bar-chart__label" x={0} y={waitLabelY}>
                {c.code}
              </text>
              <rect
                className="bar-chart__bar bar-chart__bar--wait"
                data-testid={`dashboard-bar-wait-${c.code}`}
                x={LABEL_X}
                y={waitY}
                width={waitW}
                height={BAR_H}
                rx={3}
              >
                <title>{`${c.code} tunggu: ${formatSeconds(c.avgWaitTimeMs)}`}</title>
              </rect>
              <text className="bar-chart__value" x={LABEL_X + waitW + VALUE_PAD} y={waitLabelY}>
                {formatSeconds(c.avgWaitTimeMs)}
              </text>
              <rect
                className="bar-chart__bar bar-chart__bar--service"
                data-testid={`dashboard-bar-service-${c.code}`}
                x={LABEL_X}
                y={serviceY}
                width={serviceW}
                height={BAR_H}
                rx={3}
              >
                <title>{`${c.code} layanan: ${formatSeconds(c.avgServiceTimeMs)}`}</title>
              </rect>
              <text className="bar-chart__value" x={LABEL_X + serviceW + VALUE_PAD} y={serviceLabelY}>
                {formatSeconds(c.avgServiceTimeMs)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * Renders the four dashboard charts. Returns `null` when there are no
 * categories AND no counters so a stray empty card never appears (the page-
 * level empty state short-circuits first; this is the defensive guard).
 */
export function DashboardCharts({
  report,
  counters,
}: {
  report: DailyReportDto;
  counters: readonly CounterRow[];
}) {
  const hasCats = report.perCategory.length > 0;
  // The counter chart renders when any counter exists. A `some(ticketsServed > 0)`
  // guard would be dead here (the `|| length > 0` already short-circuits true), and
  // per-counter rows that served zero are individually dropped by `BarFigure`
  // (it returns null when `rows.length === 0`), so an all-zero set still renders a
  // titled but empty chart section — acceptable for a dashboard overview.
  const hasCounters = counters.length > 0;
  if (!hasCats && !hasCounters) return null;

  const catRows = barRows(
    report.perCategory.map((c) => ({ code: c.code, id: c.code, value: c.totalTickets })),
    (v) => String(v),
  );
  const catSummary = `Total tiket per kategori: ${catRows.map((r) => `${r.code} ${r.formatted}`).join(', ')}`;

  const counterRows = barRows(
    counters.map((c) => ({ code: c.counterName, id: String(c.counterId), value: c.perf.ticketsServed })),
    (v) => String(v),
  );
  const counterSummary = `Tiket dilayani per counter: ${counterRows.map((r) => `${r.code} ${r.formatted}`).join(', ')}`;

  return (
    <section className="config-card dashboard__charts" aria-label="Grafik dashboard" data-testid="dashboard-charts">
      <h2 className="config-card__title">Grafik Dashboard</h2>
      <div className="dashboard__charts-grid">
        <BarFigure
          title="Total Tiket per Kategori"
          rows={catRows}
          testidPrefix="dashboard-bar-cat"
          fill="var(--accent)"
          summary={catSummary}
        />
        <BarFigure
          title="Tiket Dilayani per Counter"
          rows={counterRows}
          testidPrefix="dashboard-bar-counter"
          fill="var(--accent)"
          summary={counterSummary}
        />
        <DonutFigure report={report} />
        <WaitServiceFigure report={report} />
      </div>
    </section>
  );
}