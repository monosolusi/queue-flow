import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  DailyReportDto,
} from '../api/types';
import { exportDailyReport } from '../lib/export-daily-report';
import { formatSeconds } from '../lib/format';
import { RecapCharts } from '../components/RecapCharts';
import { isOverviewEmpty, loadDailyOverview, type OverviewData } from '../lib/analytics-loader';

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OverviewData }
  | { status: 'empty'; date: string };

/** The seam the page uses to write the .xlsx export. Injected so tests can
 *  assert the export wiring without invoking SheetJS in jsdom. Defaults to the
 *  real SheetJS-backed {@link exportDailyReport} (offline, no network).
 *  `Promise<void>` — SheetJS is lazily `import()`-ed so the heavy dependency
 *  splits into its own chunk and never enters the main bundle (QUE-41 AC9). */
export type DailyReportExporter = (
  report: DailyReportDto,
  audit: readonly AuditLogEntryDto[],
  fileName: string,
) => Promise<void>;

/** Today's date as the store's local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01). */
function todayLocalKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Renders an opaque audit snapshot as a compact JSON string (or `—` when null). */
function formatSnapshot(snap: AuditLogEntryDto['before']): string {
  return snap === null ? '—' : JSON.stringify(snap);
}

/**
 * The daily analytics dashboard + local export (FR-ADM-03 / QUE-26). The manager
 * picks a date and sees the day's queue performance — total visitors, average
 * wait time, average service time, a per-category breakdown, per-counter
 * performance, and the audit trail of sensitive administrative actions — then
 * exports the whole view to a local `.xlsx` (SheetJS, fully offline — NFR-REL-01).
 *
 * The page consumes only the read-side slice of {@link IAdminApi} (reporting +
 * audit + config-to-enumerate-counters) and owns no realtime/WS surface (SRP /
 * ISP — never touches caller/kiosk/tv DTOs). `exporter` is an optional seam so
 * tests can assert the export wiring without running SheetJS in jsdom.
 */
export function AnalyticsPage({
  api,
  exporter = exportDailyReport,
}: {
  api: IAdminApi;
  exporter?: DailyReportExporter;
}) {
  const [date, setDate] = useState<string>(todayLocalKey());
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadDailyOverview(api, date)
      .then((data) => {
        if (cancelled) return;
        setState(isOverviewEmpty(data) ? { status: 'empty', date } : { status: 'ready', data });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, date]);

  async function handleExport() {
    if (state.status !== 'ready') return;
    if (exporting) return;
    setExporting(true);
    try {
      await exporter(state.data.report, state.data.audit, `qms-report-${state.data.date}.xlsx`);
    } finally {
      setExporting(false);
    }
  }

  if (state.status === 'loading') {
    return <div className="analytics analytics--loading">Memuat analitik…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="analytics">
        <p className="admin-panel__error">Gagal memuat analitik: {state.message}</p>
        <Link className="btn btn--primary" to="/">
          Kembali ke Dashboard
        </Link>
      </div>
    );
  }
  if (state.status === 'empty') {
    return (
      <div className="analytics">
        <AnalyticsHeader
          date={date}
          onDateChange={setDate}
          onExport={handleExport}
          exportDisabled={true}
          exporting={exporting}
        />
        <p className="analytics__empty" data-testid="analytics-empty">
          Belum ada data antrian untuk {state.date}.
        </p>
      </div>
    );
  }

  const { report, counters, audit } = state.data;

  return (
    <div className="analytics">
      <AnalyticsHeader
        date={date}
        onDateChange={setDate}
        onExport={handleExport}
        exportDisabled={false}
        exporting={exporting}
      />

      <section className="analytics__summary" aria-label="Ringkasan harian">
        <h2 className="analytics__section-title">Ringkasan — {report.date}</h2>
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
              {formatSeconds(report.avgWaitTimeMs)}
            </span>
          </div>
          <div className="metric-tile">
            <span className="metric-tile__label">Rata-rata Waktu Layanan</span>
            <span className="metric-tile__value" data-testid="metric-service">
              {formatSeconds(report.avgServiceTimeMs)}
            </span>
          </div>
        </div>
      </section>

      <RecapCharts report={report} />

      <section className="config-card" aria-label="Per kategori">
        <h2 className="config-card__title">Per Kategori</h2>
        {report.perCategory.length === 0 ? (
          <p className="analytics__empty">Tidak ada tiket pada tanggal ini.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Kode</th>
                <th>Total Tiket</th>
                <th>Rata Waktu Tunggu</th>
                <th>Rata Waktu Layanan</th>
              </tr>
            </thead>
            <tbody>
              {report.perCategory.map((c) => (
                <tr key={c.categoryId}>
                  <td>{c.code}</td>
                  <td>{c.totalTickets}</td>
                  <td>{formatSeconds(c.avgWaitTimeMs)}</td>
                  <td>{formatSeconds(c.avgServiceTimeMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                <td>{c.perf.ticketsServed}</td>
                <td>{formatSeconds(c.perf.avgServiceTimeMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="config-card" aria-label="Audit trail">
        <h2 className="config-card__title">Audit Trail</h2>
        {audit.length === 0 ? (
          <p className="analytics__empty">Belum ada entri audit.</p>
        ) : (
          // AC4 — the 5-column audit table overflows on narrow viewports; wrap it
          // in a horizontal-scroll container (the per-category/counter tables
          // stay unwrapped — they are narrow enough).
          <div className="data-table-scroll">
            <table className="data-table data-table--audit">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Aktor</th>
                  <th>Aksi</th>
                  <th>Sebelum</th>
                  <th>Sesudah</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.occurredAt).toLocaleString()}</td>
                    <td>{a.actor}</td>
                    <td>{a.action}</td>
                    <td className="data-table__snapshot">{formatSnapshot(a.before)}</td>
                    <td className="data-table__snapshot">{formatSnapshot(a.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AnalyticsHeader({
  date,
  onDateChange,
  onExport,
  exportDisabled,
  exporting,
}: {
  date: string;
  onDateChange: (d: string) => void;
  onExport: () => void;
  exportDisabled: boolean;
  exporting: boolean;
}) {
  return (
    <header className="analytics__header">
      <div>
        <h1 className="analytics__title">Analitik Harian</h1>
        <p className="analytics__subtitle">Ekspor laporan lokal (.xlsx)</p>
      </div>
      <div className="analytics__controls">
        <label className="field">
          <span className="field__label">Tanggal</span>
          <input
            className="field__input"
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            aria-label="Tanggal laporan"
            data-testid="analytics-date"
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onExport}
          disabled={exportDisabled || exporting}
          data-testid="analytics-export"
        >
          {exporting ? 'Mengekspor…' : 'Ekspor .xlsx'}
        </button>
      </div>
    </header>
  );
}