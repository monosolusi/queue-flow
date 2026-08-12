import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto, RangeReportDto } from '../api/types';
import { daysAgoLocalKey, isDateKey, todayLocalKey } from '../lib/date';
import { exportRangeReport } from '../lib/export-range-report';
import { formatDuration } from '../lib/format';
import { loadRangeOverview, type RangeOverviewData } from '../lib/analytics-loader';
import { DateRangeField } from '../components/DateRangeField';
import { RangeTrendChart } from '../components/RangeTrendChart';
import { CategoryBreakdownChart } from '../components/CategoryBreakdownChart';
import { PageHeader } from '../components/PageHeader';
import { RELATIVE_PRESETS, RelativeRangePicker } from '../components/RelativeRangePicker';
import { useToast } from '../toast/useToast';

/** Id of the range-validation message, wired to the date fields' `aria-describedby`. */
const RANGE_ERROR_ID = 'analytics-range-error';

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: RangeOverviewData };

/** The seam the page uses to write the .xlsx export. Injected so tests can
 *  assert the export wiring without invoking SheetJS in jsdom. Defaults to the
 *  real SheetJS-backed {@link exportRangeReport} (offline, no network).
 *  `Promise<void>` — SheetJS is lazily `import()`-ed so the heavy dependency
 *  splits into its own chunk and never enters the main bundle (QUE-41 AC9). */
export type RangeReportExporter = (
  report: RangeReportDto,
  audit: readonly AuditLogEntryDto[],
  counterNameById: ReadonlyMap<number, string>,
  fileName: string,
) => Promise<void>;

/**
 * The historical analytics view (FR-ADM-03 / QUE-44) — distinct from
 * {@link DashboardPage} (live status). The manager picks a date **range** and
 * sees multi-day trends, range-aggregated per-category + per-counter
 * performance, then exports the whole view to a local `.xlsx` (SheetJS, fully
 * offline — NFR-REL-01). Defaults to the last 7 days.
 *
 * The audit trail of sensitive administrative actions used to be an in-page
 * section here; QUE-45 promoted it to its own dedicated `/audit` route (the
 * "Audit" group in the grouped left-menu, and the "Lihat log audit" link in the
 * header, both navigate there). The trail is still bundled into the `.xlsx`
 * export (the manager's whole-range snapshot) — only the in-page section moved.
 *
 * The page consumes only the read-side slice of {@link IAdminApi} (range report
 * + audit + config-to-enumerate-counters) and owns no realtime/WS surface (SRP
 * / ISP — never touches caller/kiosk/tv DTOs). `exporter` is an optional seam so
 * tests can assert the export wiring without running SheetJS in jsdom.
 */
export function AnalyticsPage({
  api,
  exporter = exportRangeReport,
}: {
  api: IAdminApi;
  exporter?: RangeReportExporter;
}) {
  const toast = useToast();
  const [from, setFrom] = useState<string>(daysAgoLocalKey(6));
  const [to, setTo] = useState<string>(todayLocalKey());
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [exporting, setExporting] = useState(false);
  // Synchronous double-click guard — `exporting` only lands after a re-render,
  // so two same-tick clicks would both start a SheetJS build (CLAUDE.md).
  const exportRef = useRef(false);

  // Defensive range guard — the calendar (`DateRangeField`) and the presets
  // only ever produce a pair of well-formed, in-order local `YYYY-MM-DD` keys,
  // so this branch is unreachable from the current UI. It stays as
  // defense-in-depth against a future caller that bypasses the calendar, and
  // it still gates the load + export so a corrupted `from`/`to` cannot reach
  // `GetRangeReportUseCase` (which rejects server-side). Typing is no longer
  // supported, so the per-field malformed/inverted tracking the text-input
  // variant needed is gone — one cheap expression is enough.
  const rangeInvalid = !isDateKey(from) || !isDateKey(to) || from > to;

  // Derive the active relative-range preset purely from `from`/`to` — there is
  // NO separate `preset` state to drift. A preset `days` is active iff `to` is
  // today AND `from` is exactly `daysAgoLocalKey(days - 1)` (the preset's first
  // day). The default page state (`from=daysAgoLocalKey(6)`, `to=todayLocalKey()`)
  // → "7 hari" is active on first render. There is no more `customMode` gate:
  // the manual range is always visible as a `DateRangeField`, and a hand-picked
  // range that coincidentally matches a preset honestly shows that preset
  // pressed (cleaner than suppressing the match).
  const activeDays = useMemo(() => {
    if (to !== todayLocalKey()) return null;
    for (const p of RELATIVE_PRESETS) {
      if (from === daysAgoLocalKey(p.days - 1)) return p.days;
    }
    return null;
    // `todayLocalKey`/`daysAgoLocalKey` are pure functions of `new Date()` and
    // the page re-derives on every `from`/`to` change; the date helpers do not
    // need to be in the dep array (the memo recomputes whenever from/to do).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  /** Jumps the range to the last `days` days. A preset click always produces a
   *  pair of well-formed, in-order keys, so it never trips `rangeInvalid`. */
  function selectRelative(days: number) {
    setFrom(daysAgoLocalKey(days - 1));
    setTo(todayLocalKey());
  }

  /** Commits a complete, in-order range picked via the `DateRangeField`
   *  calendar. Atomic (one `from` + one `to` in the same tick) so the load
   *  effect fires once, not twice. */
  function onRangeChange(f: string, t: string) {
    setFrom(f);
    setTo(t);
  }

  useEffect(() => {
    if (rangeInvalid) return;
    let cancelled = false;
    setState({ status: 'loading' });
    loadRangeOverview(api, from, to)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, from, to]);

  /**
   * Builds and downloads the range `.xlsx`.
   *
   * The `catch` is load-bearing: without it a SheetJS/Blob failure was swallowed
   * whole — the button simply returned to "Ekspor .xlsx" and the manager was
   * left believing a file had been written. Both outcomes now announce.
   */
  async function handleExport() {
    if (state.status !== 'ready' || exporting || rangeInvalid || exportRef.current) return;
    exportRef.current = true;
    setExporting(true);
    try {
      await exporter(
        state.data.report,
        state.data.audit,
        state.data.counterNameById,
        `qms-report-${state.data.from}_${state.data.to}.xlsx`,
      );
      toast.success('Laporan .xlsx berhasil diunduh.');
    } catch (err) {
      toast.error(
        `Gagal mengekspor laporan: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      exportRef.current = false;
      setExporting(false);
    }
  }

  // Every branch renders the same header; only `exportDisabled` differs. The
  // range-error node lives inside the header so it renders in every branch.
  // Bundled so a new header prop cannot be added to two of the three call sites.
  const headerProps = {
    from,
    to,
    onRangeChange,
    onExport: handleExport,
    exporting,
    rangeInvalid,
    activeDays,
    onSelectRelative: selectRelative,
  };

  if (state.status === 'loading') {
    return (
      <div className="page analytics">
        <AnalyticsHeader {...headerProps} exportDisabled={true} />
        <p className="analytics__loading" role="status" aria-live="polite">
          Memuat analitik…
        </p>
        <Link className="btn btn--secondary" to="/" data-testid="analytics-to-dashboard">
          Kembali ke Status Antrian
        </Link>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="page analytics">
        <AnalyticsHeader {...headerProps} exportDisabled={true} />
        <p className="admin-panel__error" data-testid="analytics-error">
          Gagal memuat analitik: {state.message}
        </p>
        <Link className="btn btn--secondary" to="/" data-testid="analytics-to-dashboard">
          Kembali ke Status Antrian
        </Link>
      </div>
    );
  }

  const { report, counters } = state.data;

  return (
    <div className="page analytics">
      <AnalyticsHeader {...headerProps} exportDisabled={false} />

      <section className="analytics__summary" aria-label="Ringkasan rentang">
        <h2 className="analytics__section-title">
          Ringkasan — {report.from} s/d {report.to}
        </h2>
        <div className="metric-grid">
          <div className="metric-tile">
            <span className="metric-tile__label">Total Pengunjung</span>
            <span className="metric-tile__value" data-testid="metric-total">
              {report.totalTickets}
            </span>
          </div>
          <div className="metric-tile">
            <span className="metric-tile__label">Rata-rata Waktu Tunggu</span>
            <span className="metric-tile__value" data-testid="metric-wait">
              {formatDuration(report.avgWaitTimeMs)}
            </span>
          </div>
          <div className="metric-tile">
            <span className="metric-tile__label">Rata-rata Waktu Layanan</span>
            <span className="metric-tile__value" data-testid="metric-service">
              {formatDuration(report.avgServiceTimeMs)}
            </span>
          </div>
        </div>
      </section>

      <RangeTrendChart perDay={report.perDay} />

      <section className="config-card" aria-label="Per kategori">
        <h2 className="config-card__title">Per Kategori</h2>
        {report.perCategory.length === 0 ? (
          <p className="analytics__empty">Tidak ada tiket pada rentang ini.</p>
        ) : (
          <>
            <CategoryBreakdownChart perCategory={report.perCategory} />
            <table className="data-table">
              <thead>
                <tr>
                  <th>Kategori</th>
                  <th>Total Tiket</th>
                  <th>Rata Waktu Tunggu</th>
                  <th>Rata Waktu Layanan</th>
                </tr>
              </thead>
              <tbody>
                {report.perCategory.map((c) => (
                  <tr key={c.categoryId}>
                    <td>{c.categoryName}</td>
                    <td>{c.totalTickets}</td>
                    <td>{formatDuration(c.avgWaitTimeMs)}</td>
                    <td>{formatDuration(c.avgServiceTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="config-card" aria-label="Performa counter">
        <h2 className="config-card__title">Performa Counter</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Counter</th>
              <th>Tiket Dilayani</th>
              <th>Rata Waktu Layanan</th>
            </tr>
          </thead>
          <tbody>
            {counters.map((c) => (
              <tr key={c.counterId}>
                <td>
                  {c.counterName} (#{c.counterId})
                </td>
                <td>{c.ticketsServed}</td>
                <td>{formatDuration(c.avgServiceTimeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* The audit trail moved to its own route (`/audit`, QUE-45) — the
          grouped left-menu "Audit" group resolves there, and the "Lihat log
          audit" link in the header navigates to it. The trail is still exported
          in the `.xlsx` (handleExport passes state.data.audit) — only the
          in-page section moved. */}

      <Link className="btn btn--secondary" to="/" data-testid="analytics-to-dashboard">
        Kembali ke Status Antrian
      </Link>
    </div>
  );
}

function AnalyticsHeader({
  from,
  to,
  onRangeChange,
  onExport,
  exportDisabled,
  exporting,
  rangeInvalid,
  activeDays,
  onSelectRelative,
}: {
  from: string;
  to: string;
  onRangeChange: (from: string, to: string) => void;
  onExport: () => void;
  exportDisabled: boolean;
  exporting: boolean;
  /** Defensive range guard — gates the export button and renders the shared
   *  error node. Unreachable from the calendar/presets UI (defense in depth). */
  rangeInvalid: boolean;
  /** The derived active relative-range preset (`null` = no preset matches). */
  activeDays: number | null;
  /** Jump the range to the last `days` days. */
  onSelectRelative: (days: number) => void;
}) {
  return (
    <>
      <PageHeader
        title="Analitik & Laporan"
        subtitle="Ekspor laporan lokal (.xlsx)"
        actions={
          <>
            {/* Quick relative-range presets. The manual range is always visible
                as a `DateRangeField` below the header (no "Kustom" toggle —
                manager feedback: unify the separate Kustom / calendar / textbox
                affordances into one grouped box). The actions row is all
                equal-height buttons, so the default center alignment applies. */}
            <RelativeRangePicker activeDays={activeDays} onSelect={onSelectRelative} />
            <button
              type="button"
              className="btn btn--primary"
              onClick={onExport}
              disabled={exportDisabled || exporting || rangeInvalid}
              data-testid="analytics-export"
            >
              {exporting ? 'Mengekspor…' : 'Ekspor .xlsx'}
            </button>
            {/* QUE-45 — the audit trail now lives on its own `/audit` route; this
                link is the bridge from the analytics view to it. */}
            <Link className="btn btn--secondary" to="/audit" data-testid="analytics-audit-link">
              Lihat log audit
            </Link>
          </>
        }
      />
      {/* The manual range selector — ALWAYS visible (no reveal step). One
          grouped textbox that opens a two-month range calendar on click. The
          `DateRangeField` owns its own `role="group"` (the field root), so no
          wrapping group here. Pre-filled with the current `from`/`to` so the
          manager sees the range they are customizing from. */}
      <DateRangeField
        from={from}
        to={to}
        onRangeChange={onRangeChange}
        invalid={rangeInvalid}
        describedById={rangeInvalid ? RANGE_ERROR_ID : undefined}
      />
      {/* Owned by AnalyticsHeader, not by a single view branch, so it renders
          in every state the page can be in (loading / error / ready all render
          this header). A failed load leaves the page on its error branch while
          the manager keeps editing the range — parking this node in the ready
          branch only would let `aria-invalid` travel without the
          `aria-describedby` target that explains it. Rendered as a sibling
          after the DateRangeField; the `id`/`aria-describedby` wiring is
          DOM-location-independent so the association is unchanged. */}
      {rangeInvalid && (
        <p className="admin-panel__error" id={RANGE_ERROR_ID} data-testid="analytics-range-invalid">
          Isi kedua tanggal dengan format YYYY-MM-DD, dan pastikan tanggal mulai sebelum atau sama
          dengan tanggal akhir.
        </p>
      )}
    </>
  );
}