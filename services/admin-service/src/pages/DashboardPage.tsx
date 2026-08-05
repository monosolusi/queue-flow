import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import { formatSeconds } from '../lib/format';
import { isOverviewEmpty, loadDailyOverview, type OverviewData } from '../lib/analytics-loader';
import { DashboardCharts } from '../components/DashboardCharts';

/**
 * The manager landing page (admin-service modernization): a KPI tile grid +
 * four hand-rolled offline SVG graphs + a recent-activity feed. Mirrors the
 * AnalyticsPage state machine (loading / empty / error / ready) and reuses the
 * same read-side loader (DRY — {@link loadDailyOverview}) so the dashboard and
 * the full analytics page never drift on what "a day's data" means.
 *
 * The page consumes only the read-side slice of {@link IAdminApi} (reporting +
 * audit + config-to-enumerate-counters) and owns no realtime/WS surface (SRP /
 * ISP — never touches caller/kiosk/tv DTOs).
 */

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OverviewData }
  | { status: 'empty'; date: string };

/** Today's date as the store's local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01).
 *  Duplicated from AnalyticsPage (a tiny leaf — per CLAUDE.md, 4× duplication of a
 *  ~10-line leaf beats a shared/synced module crossing the standalone-service
 *  boundary). */
function todayLocalKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function DashboardPage({ api }: { api: IAdminApi }) {
  const [date, setDate] = useState<string>(todayLocalKey());
  const [state, setState] = useState<ViewState>({ status: 'loading' });

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

  if (state.status === 'loading') {
    return (
      <div className="dashboard dashboard--loading">
        {/* DashboardHeader renders the <h1> so the page owns its heading on
            every view — the AppShell topbar title is intentionally a non-heading
            <span> and relies on the routed page providing the <h1>. */}
        <DashboardHeader date={date} onDateChange={setDate} />
        <p className="dashboard__status" role="status" aria-live="polite">
          Memuat dashboard…
        </p>
      </div>
    );
  }
  if (state.status === 'error') {
    // No wizard CTA: SetupGuard already guarantees setup is complete before
    // this page mounts, so a failure here is a transient core-api outage, not a
    // setup gap — sending the manager to the first-run wizard would be the
    // wrong recovery. The AppShell's left nav stays available for navigation.
    // The header's date control doubles as a retry affordance (changing the date
    // re-triggers the load effect) and keeps the <h1> present for AT orientation.
    return (
      <div className="dashboard">
        <DashboardHeader date={date} onDateChange={setDate} />
        <p className="admin-panel__error" data-testid="dashboard-error">
          Gagal memuat dashboard: {state.message}
        </p>
      </div>
    );
  }
  if (state.status === 'empty') {
    return (
      <div className="dashboard">
        <DashboardHeader date={date} onDateChange={setDate} />
        <p className="dashboard__empty" data-testid="dashboard-empty">
          Belum ada data antrian untuk {state.date}.
        </p>
      </div>
    );
  }

  const { report, counters, audit } = state.data;
  const totalServed = counters.reduce((n, c) => n + c.perf.ticketsServed, 0);
  // Last 5 audit entries, most-recent-first (the loader returns oldest-first).
  const recentAudit = [...audit].slice(-5).reverse();

  return (
    <div className="dashboard">
      <DashboardHeader date={date} onDateChange={setDate} />

      <section className="metric-grid" aria-label="Ringkasan dashboard">
        <div className="metric-tile">
          <span className="metric-tile__label">Total Pengunjung</span>
          <span className="metric-tile__value" data-testid="kpi-total">
            {report.totalTickets}
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-tile__label">Rata-rata Waktu Tunggu</span>
          <span className="metric-tile__value" data-testid="kpi-wait">
            {formatSeconds(report.avgWaitTimeMs)}
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-tile__label">Rata-rata Waktu Layanan</span>
          <span className="metric-tile__value" data-testid="kpi-service">
            {formatSeconds(report.avgServiceTimeMs)}
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-tile__label">Tiket Dilayani</span>
          <span className="metric-tile__value" data-testid="kpi-served">
            {totalServed}
          </span>
        </div>
      </section>

      <DashboardCharts report={report} counters={counters} />

      <section className="config-card" aria-label="Aktivitas terbaru">
        <h2 className="config-card__title">Aktivitas Terbaru</h2>
        {recentAudit.length === 0 ? (
          <p className="dashboard__empty">Belum ada aktivitas.</p>
        ) : (
          <ul className="dashboard__activity">
            {recentAudit.map((a) => (
              <li key={a.id} className="dashboard__activity-item">
                <span className="dashboard__activity-action">{a.action}</span>
                <span className="dashboard__activity-time">
                  {new Date(a.occurredAt).toLocaleString()}
                </span>
                <span className="dashboard__activity-actor">{a.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DashboardHeader({
  date,
  onDateChange,
}: {
  date: string;
  onDateChange: (d: string) => void;
}) {
  return (
    <header className="dashboard__header">
      <div>
        <h1 className="dashboard__title">Dashboard</h1>
      </div>
      <div className="dashboard__controls">
        <label className="field">
          <span className="field__label">Tanggal</span>
          <input
            className="field__input"
            type="date"
            value={date}
            onChange={(e) => onDateChange(e.target.value)}
            aria-label="Tanggal dashboard"
            data-testid="dashboard-date"
          />
        </label>
        <Link className="btn btn--secondary" to="/analytics">
          Lihat analitik lengkap
        </Link>
      </div>
    </header>
  );
}