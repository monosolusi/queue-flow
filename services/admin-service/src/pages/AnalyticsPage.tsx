import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto, RangeReportDto } from '../api/types';
import { daysAgoLocalKey, isDateKey, todayLocalKey } from '../lib/date';
import { exportRangeReport } from '../lib/export-range-report';
import { formatDuration } from '../lib/format';
import { loadRangeOverview, type RangeOverviewData } from '../lib/analytics-loader';
import { DateField } from '../components/DateField';
import { RangeTrendChart } from '../components/RangeTrendChart';
import { CategoryBreakdownChart } from '../components/CategoryBreakdownChart';
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

  // The date fields are text inputs now (DateField), so they accept a partial or
  // malformed key where `type="date"` silently coerced to ''. Validating the
  // shape here keeps a half-typed date from reaching `GetRangeReportUseCase`
  // (which rejects malformed keys server-side — this is defense in depth).
  //
  // Tracked per field so only the offending input is flagged: a malformed `from`
  // marks `from` alone, while an inverted range marks both (the pair is what is
  // wrong). `rangeInvalid` is their union — identical to the previous single
  // expression, so the load gate and the export button are unchanged.
  //
  // The inversion test is gated on BOTH sides being well-formed. `from > to` is a
  // lexicographic compare that only means "inverted" for two real `YYYY-MM-DD`
  // keys; run against a partial value it mis-attributes the fault to the *other*,
  // valid field — clearing "Sampai" makes `'2026-08-05' > ''` true, and retyping
  // "Dari" as `'2026-1'` makes `'2026-1' > '2026-08-11'` true (char-wise
  // `'1' > '0'`). Since `DateField` is a raw passthrough, both values pass through
  // those partial states on every keystroke.
  const fromMalformed = !isDateKey(from);
  const toMalformed = !isDateKey(to);
  const inverted = !fromMalformed && !toMalformed && from > to;
  const fromInvalid = fromMalformed || inverted;
  const toInvalid = toMalformed || inverted;
  const rangeInvalid = fromInvalid || toInvalid;

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
    onFromChange: setFrom,
    onToChange: setTo,
    onExport: handleExport,
    exporting,
    fromInvalid,
    toInvalid,
    rangeInvalid,
  };

  if (state.status === 'loading') {
    return (
      <div className="analytics">
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
      <div className="analytics">
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
    <div className="analytics">
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
  onFromChange,
  onToChange,
  onExport,
  exportDisabled,
  exporting,
  fromInvalid,
  toInvalid,
  rangeInvalid,
}: {
  from: string;
  to: string;
  onFromChange: (d: string) => void;
  onToChange: (d: string) => void;
  onExport: () => void;
  exportDisabled: boolean;
  exporting: boolean;
  /** Only the offending field is flagged; an inverted range flags both. */
  fromInvalid: boolean;
  toInvalid: boolean;
  /** Their union — gates the export button and renders the shared error node. */
  rangeInvalid: boolean;
}) {
  return (
    <header className="analytics__header">
      <div>
        <h1 className="analytics__title">Analitik &amp; Laporan</h1>
        <p className="analytics__subtitle">Ekspor laporan lokal (.xlsx)</p>
      </div>
      <div className="analytics__controls">
        <DateField
          label="Dari"
          value={from}
          onChange={onFromChange}
          ariaLabel="Tanggal mulai"
          testId="analytics-from"
          invalid={fromInvalid}
          describedById={fromInvalid ? RANGE_ERROR_ID : undefined}
        />
        <DateField
          label="Sampai"
          value={to}
          onChange={onToChange}
          ariaLabel="Tanggal akhir"
          testId="analytics-to"
          invalid={toInvalid}
          describedById={toInvalid ? RANGE_ERROR_ID : undefined}
        />
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
      </div>
      {/* Owned by the header, not by a single view branch, so it renders in
          every state the page can be in. The fields are flagged from the same
          `from`/`to` the header already holds, and a failed load leaves the page
          on its error branch while the manager keeps editing dates — parking
          this node in the ready branch only would let `aria-invalid` travel
          without the `aria-describedby` target that explains it. */}
      {rangeInvalid && (
        <p className="admin-panel__error" id={RANGE_ERROR_ID} data-testid="analytics-range-invalid">
          Isi kedua tanggal dengan format YYYY-MM-DD, dan pastikan tanggal mulai sebelum atau sama
          dengan tanggal akhir.
        </p>
      )}
    </header>
  );
}