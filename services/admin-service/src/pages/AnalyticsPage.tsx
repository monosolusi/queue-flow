import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto, RangeReportDto } from '../api/types';
import { exportRangeReport } from '../lib/export-range-report';
import { formatSeconds } from '../lib/format';
import { loadRangeOverview, type RangeOverviewData } from '../lib/analytics-loader';
import { RangeTrendChart } from '../components/RangeTrendChart';

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

/** Today's date as the store's local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01). */
function todayLocalKey(): string {
  const d = new Date();
  return formatKey(d);
}

/** `n` days before today as the store's local `YYYY-MM-DD`. */
function daysAgoLocalKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return formatKey(d);
}

function formatKey(d: Date): string {
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
 * The historical analytics view (FR-ADM-03 / QUE-44) — distinct from
 * {@link DashboardPage} (live status). The manager picks a date **range** and
 * sees multi-day trends, range-aggregated per-category + per-counter
 * performance, and the audit trail, then exports the whole view to a local
 * `.xlsx` (SheetJS, fully offline — NFR-REL-01). Defaults to the last 7 days.
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
  const [from, setFrom] = useState<string>(daysAgoLocalKey(6));
  const [to, setTo] = useState<string>(todayLocalKey());
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [exporting, setExporting] = useState(false);

  const rangeInvalid = from > to;

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

  async function handleExport() {
    if (state.status !== 'ready' || exporting || rangeInvalid) return;
    setExporting(true);
    try {
      await exporter(
        state.data.report,
        state.data.audit,
        state.data.counterNameById,
        `qms-report-${state.data.from}_${state.data.to}.xlsx`,
      );
    } finally {
      setExporting(false);
    }
  }

  if (state.status === 'loading') {
    return (
      <div className="analytics">
        <AnalyticsHeader
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          onExport={handleExport}
          exportDisabled={true}
          exporting={exporting}
          rangeInvalid={rangeInvalid}
        />
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
        <AnalyticsHeader
          from={from}
          to={to}
          onFromChange={setFrom}
          onToChange={setTo}
          onExport={handleExport}
          exportDisabled={true}
          exporting={exporting}
          rangeInvalid={rangeInvalid}
        />
        <p className="admin-panel__error" data-testid="analytics-error">
          Gagal memuat analitik: {state.message}
        </p>
        <Link className="btn btn--secondary" to="/" data-testid="analytics-to-dashboard">
          Kembali ke Status Antrian
        </Link>
      </div>
    );
  }

  const { report, counters, audit } = state.data;

  return (
    <div className="analytics">
      <AnalyticsHeader
        from={from}
        to={to}
        onFromChange={setFrom}
        onToChange={setTo}
        onExport={handleExport}
        exportDisabled={false}
        exporting={exporting}
        rangeInvalid={rangeInvalid}
      />

      {rangeInvalid && (
        <p className="admin-panel__error" data-testid="analytics-range-invalid">
          Tanggal mulai harus sebelum atau sama dengan tanggal akhir.
        </p>
      )}

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

      <RangeTrendChart perDay={report.perDay} />

      <section className="config-card" aria-label="Per kategori">
        <h2 className="config-card__title">Per Kategori</h2>
        {report.perCategory.length === 0 ? (
          <p className="analytics__empty">Tidak ada tiket pada rentang ini.</p>
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
                <td>{c.ticketsServed}</td>
                <td>{formatSeconds(c.avgServiceTimeMs)}</td>
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
  rangeInvalid,
}: {
  from: string;
  to: string;
  onFromChange: (d: string) => void;
  onToChange: (d: string) => void;
  onExport: () => void;
  exportDisabled: boolean;
  exporting: boolean;
  rangeInvalid: boolean;
}) {
  return (
    <header className="analytics__header">
      <div>
        <h1 className="analytics__title">Analitik &amp; Laporan</h1>
        <p className="analytics__subtitle">Ekspor laporan lokal (.xlsx)</p>
      </div>
      <div className="analytics__controls">
        <label className="field">
          <span className="field__label">Dari</span>
          <input
            className="field__input"
            type="date"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            aria-label="Tanggal mulai"
            data-testid="analytics-from"
          />
        </label>
        <label className="field">
          <span className="field__label">Sampai</span>
          <input
            className="field__input"
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            aria-label="Tanggal akhir"
            data-testid="analytics-to"
          />
        </label>
        <button
          type="button"
          className="btn btn--primary"
          onClick={onExport}
          disabled={exportDisabled || exporting || rangeInvalid}
          data-testid="analytics-export"
        >
          {exporting ? 'Mengekspor…' : 'Ekspor .xlsx'}
        </button>
      </div>
    </header>
  );
}