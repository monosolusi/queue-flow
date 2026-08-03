import type { CategoryBreakdownDto, DailyReportDto } from '../api/types';
import { formatSeconds } from '../lib/format';

/**
 * The three FR-ADM-03 daily-recap metrics, one bar chart each. Each chart is a
 * single-series magnitude comparison across categories, so the bar length
 * encodes the value and the category code labels it — no categorical color is
 * needed (one accent hue, the sequential-default per the dataviz method). The
 * chart's accessible name + per-bar `<title>` carry the values for AT/tooltip;
 * the sibling "Per Kategori" table is the always-available table view.
 */
interface MetricDef {
  /** Short id used in the `data-testid` (`recap-bar-<id>-<code>`). */
  readonly id: 'total' | 'wait' | 'service';
  /** The per-category field to plot. */
  readonly field: keyof Pick<CategoryBreakdownDto, 'totalTickets' | 'avgWaitTimeMs' | 'avgServiceTimeMs'>;
  readonly title: string;
  readonly unit: 'count' | 'ms';
}

const METRICS: readonly MetricDef[] = [
  { id: 'total', field: 'totalTickets', title: 'Total Pengunjung', unit: 'count' },
  { id: 'wait', field: 'avgWaitTimeMs', title: 'Rata-rata Waktu Tunggu', unit: 'ms' },
  { id: 'service', field: 'avgServiceTimeMs', title: 'Rata-rata Waktu Layanan', unit: 'ms' },
];

function formatValue(value: number, unit: 'count' | 'ms'): string {
  return unit === 'count' ? String(value) : formatSeconds(value);
}

// SVG geometry (viewBox user units). The svg scales to its container via
// `width:100%`; the value column is reserved so the tip label never clips.
const VIEW_W = 360;
const LABEL_X = 32; // left edge of the bar area (category code sits in 0..LABEL_X)
const VALUE_RESERVE = 64; // room for the tip value label
const BAR_AREA_W = VIEW_W - LABEL_X - VALUE_RESERVE; // 264
const BAR_H = 16; // ≤24 per the mark spec — thin marks, air around them
const ROW_GAP = 6; // surface shows through between rows (the 2px-gap rule, widened)
const PAD_TOP = 4;
const PAD_BOTTOM = 2;
const VALUE_PAD = 6; // gap between the bar tip and the value label

/**
 * Renders the "Grafik Rekapitulasi Harian" section (FR-ADM-03 / QUE-6): three
 * horizontal bar charts — Total Pengunjung, Rata-rata Waktu Tunggu, Rata-rata
 * Waktu Layanan — one bar per category, drawn as hand-rolled offline SVG (no
 * chart library, NFR-REL-01 — mirrors the audio-sequencer minimal-dependency
 * precedent). Pure presentational: fed entirely by {@link DailyReportDto}'s
 * existing `perCategory` slice; no API, realtime, or state of its own (SRP), and
 * it consumes no admin/reporting DTO beyond the report already loaded by the
 * page (ISP).
 *
 * Returns `null` when there are no categories so a stray empty card never
 * appears (the page-level empty state short-circuits first; this is the
 * defensive guard).
 */
export function RecapCharts({ report }: { report: DailyReportDto }) {
  const categories = report.perCategory;
  if (categories.length === 0) return null;

  return (
    <section className="config-card" aria-label="Grafik Rekapitulasi">
      <h2 className="config-card__title">Grafik Rekapitulasi</h2>
      <div className="recap-charts" data-testid="recap-charts">
        {METRICS.map((metric) => (
          <RecapChart key={metric.id} metric={metric} categories={categories} />
        ))}
      </div>
    </section>
  );
}

function RecapChart({
  metric,
  categories,
}: {
  metric: MetricDef;
  categories: readonly CategoryBreakdownDto[];
}) {
  const rows = categories.map((c) => ({ code: c.code, value: c[metric.field] }));
  const max = Math.max(1, ...rows.map((r) => r.value));
  const chartH = PAD_TOP + rows.length * BAR_H + (rows.length - 1) * ROW_GAP + PAD_BOTTOM;
  // Readable summary for AT + the SVG's accessible name: "Total Pengunjung per kategori: A 3, B 1".
  const summary = `${metric.title} per kategori: ${rows
    .map((r) => `${r.code} ${formatValue(r.value, metric.unit)}`)
    .join(', ')}`;

  return (
    <figure className="recap-chart">
      <figcaption className="recap-chart__title">{metric.title}</figcaption>
      <svg
        className="recap-chart__svg"
        viewBox={`0 0 ${VIEW_W} ${chartH}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {rows.map((r, i) => {
          const y = PAD_TOP + i * (BAR_H + ROW_GAP);
          const w = (r.value / max) * BAR_AREA_W;
          const labelY = y + BAR_H - 4; // baseline-centred for an ~11px font in a 16px bar
          return (
            <g key={r.code}>
              <text className="recap-chart__label" x={0} y={labelY}>
                {r.code}
              </text>
              <rect
                className="recap-chart__bar"
                data-testid={`recap-bar-${metric.id}-${r.code}`}
                x={LABEL_X}
                y={y}
                width={w}
                height={BAR_H}
                rx={3}
              >
                <title>{`${r.code}: ${formatValue(r.value, metric.unit)}`}</title>
              </rect>
              <text className="recap-chart__value" x={LABEL_X + w + VALUE_PAD} y={labelY}>
                {formatValue(r.value, metric.unit)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}