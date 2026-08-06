import { Link } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';
import type { SystemConfigurationDto } from '../api/types';
import { COUNTER_STATUS_LABELS } from '../lib/labels';
import {
  counterStatuses,
  loadLiveDashboard,
  nowServingTicket,
  waitingByCategory,
  type LiveDashboardData,
} from '../lib/dashboard-loader';
import { usePoll } from '../lib/use-poll';

/**
 * The manager landing page — **live operational status** (FR-ADM-03 / QUE-44).
 * Distinct from {@link AnalyticsPage} (historical): this view shows what is
 * happening *now* — the now-serving ticket, waiting counts per category, and
 * each counter's active/idle status — refreshed by a REST poll every 8 s with a
 * manual "Muat Ulang" button.
 *
 * admin-service is a config/wizard/analytics tool that QUE-44 expands into a
 * read-only **operational monitor**: it REST-polls the live board + counters
 * (no WebSocket — `src/test/setup.ts` SRP note; polling keeps the boundary
 * clean: read-only `IAdminApi`, no realtime participation, no caller/tv DTO
 * leakage beyond the board + counters the dashboard reads). The page consumes
 * only that read-side slice (ISP) and owns no write surface.
 *
 * The boot-fetched {@link SystemConfigurationDto} is threaded in from `App` (not
 * re-fetched per tick) so a poll never burns a round-trip just to label
 * categories; the poll is gated on `config` being present.
 */
const POLL_INTERVAL_MS = 8000;

export function DashboardPage({
  api,
  config,
}: {
  api: IAdminApi;
  config: SystemConfigurationDto | null;
}) {
  const poll = usePoll<LiveDashboardData>(
    () => loadLiveDashboard(api, config as SystemConfigurationDto),
    POLL_INTERVAL_MS,
    { enabled: !!config },
  );

  if (!config || poll.loading) {
    return <DashboardSkeleton />;
  }
  if (poll.error && !poll.data) {
    // No wizard CTA: SetupGuard already guarantees setup is complete before this
    // page mounts, so a failure here is a transient core-api outage. The shell's
    // left nav stays available; "Muat Ulang" is the retry affordance.
    return (
      <div className="status-dashboard">
        <DashboardHeader lastUpdated={poll.lastUpdated} onRefresh={poll.refresh} />
        <p className="admin-panel__error" data-testid="dashboard-error">
          Gagal memuat status antrian: {poll.error}
        </p>
      </div>
    );
  }

  const data = poll.data as LiveDashboardData;
  const nowServing = nowServingTicket(data.board);
  const nowServingCounterName =
    nowServing !== null
      ? (data.counters.find((c) => c.counterId === nowServing.counterId)?.counterName ??
        `Counter ${nowServing.counterId}`)
      : null;
  const waiting = waitingByCategory(data.board, data.categories);
  const counters = counterStatuses(data.counters, data.board);

  return (
    <div className="status-dashboard">
      <DashboardHeader lastUpdated={poll.lastUpdated} onRefresh={poll.refresh} />

      {poll.error && (
        <p className="status-dashboard__stale" role="status" aria-live="polite" data-testid="dashboard-stale">
          Pembaruan terakhir gagal — menampilkan data sebelumnya.
        </p>
      )}

      <section className="now-serving" aria-label="Panggilan saat ini">
        <h2 className="config-card__title">Sedang Dilayani</h2>
        {nowServing !== null ? (
          <div className="now-serving__card">
            <span className="now-serving__number" data-testid="now-serving-number">
              {nowServing.ticketNumber}
            </span>
            <span className="now-serving__counter" data-testid="now-serving-counter">
              {nowServingCounterName}
            </span>
          </div>
        ) : (
          <p className="now-serving__empty" data-testid="now-serving-empty">
            Tidak ada panggilan aktif.
          </p>
        )}
      </section>

      <section className="config-card" aria-label="Antrian menunggu per kategori">
        <h2 className="config-card__title">Menunggu per Kategori</h2>
        {waiting.length === 0 ? (
          <p className="status-dashboard__empty">Belum ada kategori dikonfigurasi.</p>
        ) : (
          <div className="waiting-grid" aria-live="polite" data-testid="waiting-grid">
            {waiting.map((cat) => (
              <div className="waiting-grid__tile" key={cat.categoryId}>
                <span
                  className="waiting-grid__count"
                  data-testid={`waiting-count-${cat.code}`}
                >
                  {cat.count}
                </span>
                <span className="waiting-grid__label">{cat.name}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="config-card" aria-label="Status counter">
        <h2 className="config-card__title">Status Counter</h2>
        {counters.length === 0 ? (
          <p className="status-dashboard__empty">Belum ada counter dikonfigurasi.</p>
        ) : (
          <ul className="counter-status" data-testid="counter-status-list">
            {counters.map((c) => (
              <li className="counter-status__item" key={c.counterId}>
                <span className="counter-status__name">{c.counterName}</span>
                <span
                  className={`counter-status__badge counter-status__badge--${c.status}`}
                  data-testid={`counter-status-${c.counterId}`}
                >
                  {COUNTER_STATUS_LABELS[c.status]}
                </span>
                {c.activeTicketNumber !== null && (
                  <span className="counter-status__ticket" data-testid={`counter-ticket-${c.counterId}`}>
                    {c.activeTicketNumber}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link className="btn btn--secondary" to="/analytics" data-testid="dashboard-to-analytics">
        Lihat Analitik
      </Link>
    </div>
  );
}

function DashboardHeader({
  lastUpdated,
  onRefresh,
}: {
  lastUpdated: number | null;
  onRefresh: () => void;
}) {
  return (
    <header className="status-dashboard__header">
      <div>
        <h1 className="status-dashboard__title">Status Antrian</h1>
        <p className="status-dashboard__subtitle">Pemantauan langsung — diperbarui otomatis</p>
      </div>
      <div className="status-dashboard__controls">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onRefresh}
          data-testid="dashboard-refresh"
        >
          Muat Ulang
        </button>
        {lastUpdated !== null && (
          <span className="status-dashboard__updated" data-testid="dashboard-updated">
            Terakhir: {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
      </div>
    </header>
  );
}

/** The loading skeleton — `role="status" aria-busy"` + `.sr-only` label + decorative
 *  `.skeleton` shapes (CLAUDE.md recipe; jsdom `css:false`-safe via class asserts). */
function DashboardSkeleton() {
  return (
    <div className="status-dashboard" role="status" aria-busy="true">
      <header className="status-dashboard__header">
        <div>
          <h1 className="status-dashboard__title">Status Antrian</h1>
          <p className="status-dashboard__subtitle">Pemantauan langsung — diperbarui otomatis</p>
        </div>
      </header>
      <span className="sr-only">Memuat status antrian…</span>
      <div className="skeleton skeleton--lg" aria-hidden="true" data-testid="dashboard-skeleton" />
      <div className="skeleton skeleton--grid" aria-hidden="true">
        <div className="skeleton skeleton--tile" />
        <div className="skeleton skeleton--tile" />
      </div>
    </div>
  );
}