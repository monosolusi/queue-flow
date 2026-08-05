import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminApi } from './api/admin-api';
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
 * `/`         — the manager Dashboard landing page (KPI tiles + graphs + recent
 *               activity), guarded by {@link SetupGuard}: a clean store
 *               (isInitialSetupCompleted === false) redirects to `/wizard`.
 * `/config`   — the operational config panel, guarded by {@link SetupGuard}.
 * `/wizard`   — the 5-step first-run setup wizard (reachable directly so the
 *               manager can re-edit configuration after initial setup too).
 * `/analytics` — the daily analytics dashboard + local `.xlsx` export
 *               (FR-ADM-03 / QUE-26), guarded by {@link SetupGuard}.
 *
 * The admin app is a config/wizard/analytics/dashboard tool, never a queue
 * monitor (SRP): it consumes only `IAdminApi` and never touches caller/kiosk/tv
 * DTOs (ISP). `api` is an optional prop so tests can inject a fake without
 * touching the network.
 *
 * The manager-configured brand color (QUE-36) is applied to the runtime
 * `--accent` once on mount (QUE-37 AC6), decoupling the app-wide theme from the
 * routed pages. A redundant cheap GET on a single-user manager device is
 * acceptable vs. prop-drilling the color through `SetupGuard` + 4 pages. The
 * static `#2563eb` default stays in place on failure (no flash — it IS the
 * default). The same fetch supplies the shell's `storeName` chrome (sidebar
 * brand label) without a second round-trip.
 */
export function App({ api }: { api?: IAdminApi } = {}) {
  const adminApi = useMemo(() => api ?? new AdminApi(), [api]);
  const [storeName, setStoreName] = useState<string | undefined>(undefined);

  useEffect(() => {
    adminApi
      .getSystemConfig()
      .then((c) => {
        applyBrandColor(c.brandColor);
        setStoreName(c.storeName);
      })
      .catch(() => {
        /* keep the static `#2563eb` default on fetch failure; storeName stays
           'QMS Admin' (the shell's own fallback). */
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
                <DashboardPage api={adminApi} />
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