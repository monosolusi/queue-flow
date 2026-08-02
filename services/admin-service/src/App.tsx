import { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminApi } from './api/admin-api';
import { SetupGuard } from './components/SetupGuard';
import { AdminPanel } from './pages/AdminPanel';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { WizardPage } from './pages/WizardPage';

/**
 * Top-level routing for the admin panel + first-run wizard (FR-WZD-01..06).
 *
 * `/`         — the operational config panel, guarded by {@link SetupGuard}: a
 *               clean store (isInitialSetupCompleted === false) redirects to
 *               `/wizard`.
 * `/wizard`   — the 4-step first-run setup wizard (reachable directly so the
 *               manager can re-edit configuration after initial setup too).
 * `/analytics` — the daily analytics dashboard + local `.xlsx` export
 *               (FR-ADM-03 / QUE-26), guarded by {@link SetupGuard}.
 *
 * The admin app is a config/wizard/analytics tool, never a queue monitor (SRP):
 * it consumes only `IAdminApi` and never touches caller/kiosk/tv DTOs (ISP).
 * `api` is an optional prop so tests can inject a fake without touching the
 * network.
 */
export function App({ api }: { api?: IAdminApi } = {}) {
  const adminApi = useMemo(() => api ?? new AdminApi(), [api]);

  return (
    <Routes>
      <Route
        path="/"
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
  );
}