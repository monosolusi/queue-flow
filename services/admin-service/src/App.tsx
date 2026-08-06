import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminApi } from './api/admin-api';
import type { SystemConfigurationDto } from './api/types';
import { applyBrandColor } from './lib/theme';
import { SetupGuard } from './components/SetupGuard';
import { AppShell } from './components/AppShell';
import { AdminPanel } from './pages/AdminPanel';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DashboardPage } from './pages/DashboardPage';
import { WizardPage } from './pages/WizardPage';

/**
 * Top-level routing for the admin panel + first-run wizard (FR-WZD-01..06).
 *
 * `/`         — the manager Dashboard: **live operational status** (now-serving,
 *               waiting counts per category, counter active/idle), REST-polled
 *               (QUE-44), guarded by {@link SetupGuard}: a clean store
 *               (isInitialSetupCompleted === false) redirects to `/wizard`.
 * `/config`   — the operational config panel, guarded by {@link SetupGuard}.
 * `/wizard`   — the 5-step first-run setup wizard (reachable directly so the
 *               manager can re-edit configuration after initial setup too).
 * `/analytics` — the **historical analytics** view (multi-day range trends,
 *               per-category/counter performance, audit trail, local `.xlsx`
 *               export) (FR-ADM-03 / QUE-44), guarded by {@link SetupGuard}.
 *
 * The admin app is a config/wizard/analytics/dashboard tool. QUE-44 expands it
 * into a read-only **operational monitor** for the live dashboard: it REST-polls
 * `GET /api/queue/board` + `GET /api/counters` (no WebSocket — polling keeps the
 * SRP/ISP boundary clean: read-only `IAdminApi`, no realtime participation, no
 * caller/kiosk/tv DTO leakage beyond the board + counters the dashboard reads).
 * It never owns a write/realtime surface. `api` is an optional prop so tests can
 * inject a fake without touching the network.
 *
 * The manager-configured brand color (QUE-36) is applied to the runtime
 * `--accent` once on mount (QUE-37 AC6), decoupling the app-wide theme from the
 * routed pages. A redundant cheap GET on a single-user manager device is
 * acceptable vs. prop-drilling the color through `SetupGuard` + 4 pages. The
 * static `#2563eb` default stays in place on failure (no flash — it IS the
 * default). The same fetch supplies the shell's `storeName` chrome (sidebar
 * brand label) AND threads the {@link SystemConfigurationDto} to the dashboard
 * (categories for the waiting-counts grid) without a second round-trip — the
 * dashboard poll reuses this config instead of re-fetching it every tick.
 */
export function App({ api }: { api?: IAdminApi } = {}) {
  const adminApi = useMemo(() => api ?? new AdminApi(), [api]);
  const [storeName, setStoreName] = useState<string | undefined>(undefined);
  const [config, setConfig] = useState<SystemConfigurationDto | null>(null);

  useEffect(() => {
    adminApi
      .getSystemConfig()
      .then((c) => {
        applyBrandColor(c.brandColor);
        setStoreName(c.storeName);
        setConfig(c);
      })
      .catch(() => {
        /* keep the static `#2563eb` default on fetch failure; storeName stays
           'QMS Admin' (the shell's own fallback). `config` stays null and the
           dashboard renders its skeleton until a later poll re-fetches it. */
      });
  }, [adminApi]);

  return (
    <>
      {/* AC8 — skip link for keyboard users; visually hidden until focused. */}
      <a href="#main-content" className="skip-link">
        Lewati ke konten
      </a>
      {/* AC8 — single <main> landmark per route (the AppShell owns it; the
          routed page owns the h1). The wizard route bypasses the shell so the
          wizard keeps its own full-width layout. */}
      <AppShell storeName={storeName}>
        <Routes>
          <Route
            path="/"
            element={
              <SetupGuard api={adminApi}>
                <DashboardPage api={adminApi} config={config} />
              </SetupGuard>
            }
          />
          <Route
            path="/config"
            element={
              <SetupGuard api={adminApi}>
                <AdminPanel api={adminApi} />
              </SetupGuard>
            }
          />
          <Route
            path="/analytics"
            element={
              <SetupGuard api={adminApi}>
                <AnalyticsPage api={adminApi} />
              </SetupGuard>
            }
          />
          <Route path="/wizard" element={<WizardPage api={adminApi} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </>
  );
}