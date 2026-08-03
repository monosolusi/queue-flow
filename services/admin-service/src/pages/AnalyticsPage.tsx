import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  CounterPerformanceDto,
  DailyReportDto,
} from '../api/types';
import { exportDailyReport } from '../lib/export-daily-report';
import { formatSeconds } from '../lib/format';
import { RecapCharts } from '../components/RecapCharts';

/** A counter row in the performance table (the routing-rule display name + its read). */
interface CounterRow {
  readonly counterId: number;
  readonly counterName: string;
  readonly perf: CounterPerformanceDto;
}

/** The fully-loaded analytics view for one date. */
interface AnalyticsData {
  readonly date: string;
  readonly report: DailyReportDto;
  readonly counters: readonly CounterRow[];
  readonly audit: readonly AuditLogEntryDto[];
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: AnalyticsData }
  | { status: 'empty'; date: string };

/** The seam the page uses to write the .xlsx export. Injected so tests can
 *  assert the export wiring without invoking SheetJS in jsdom. Defaults to the
 *  real SheetJS-backed {@link exportDailyReport} (offline, no network). */
export type DailyReportExporter = (
  report: DailyReportDto,
  audit: readonly AuditLogEntryDto[],
  fileName: string,
) => void;

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
    load(api, date)
      .then((data) => {
        if (cancelled) return;
        const isEmpty =
          data.report.totalTickets === 0 &&
          data.audit.length === 0 &&
          data.counters.every((c) => c.perf.ticketsServed === 0);
        setState(isEmpty ? { status: 'empty', date } : { status: 'ready', data });
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
      exporter(state.data.report, state.data.audit, `qms-report-${state.data.date}.xlsx`);
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
          Kembali ke Admin
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

      <section className="config-card" aria-label="Ringkasan harian">
        <h2 className="config-card__title">Ringkasan — {report.date}</h2>
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
        <Link className="btn btn--secondary" to="/">
          Admin
        </Link>
      </div>
    </header>
  );
}

/**
 * Loads the full analytics view for one date: the daily report, the audit trail,
 * and per-counter performance (counters enumerated from the config's routing
 * rules). The config read is needed only to label counters by name; if it fails
 * the whole load fails (no partial view) — the dashboard is read-only, so a
 * transient error is preferable to silently dropping a section.
 */
async function load(api: IAdminApi, date: string): Promise<AnalyticsData> {
  const [report, config, audit] = await Promise.all([
    api.getDailyReport(date),
    api.getSystemConfig(),
    api.getAuditLog(),
  ]);
  const counters: CounterRow[] = await Promise.all(
    config.routingRules.map((r) =>
      api.getCounterPerformance(r.counterId, date).then((perf) => ({
        counterId: r.counterId,
        counterName: r.counterName,
        perf,
      })),
    ),
  );
  return { date, report, counters, audit };
}