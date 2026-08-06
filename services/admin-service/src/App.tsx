import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminAppApi } from './api/admin-api';
import { applyBrandColor } from './lib/theme';
import { SetupGuard } from './components/SetupGuard';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/auth-context';
import { RequireAuth } from './auth/RequireAuth';
import { AdminPanel } from './pages/AdminPanel';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { WizardPage } from './pages/WizardPage';

/**
 * Top-level routing for the admin panel + first-run wizard (FR-WZD-01..06).
 *
 * `/login`    — the manager sign-in page (public — reachable without a token;
 *               RequireAuth sends unauthenticated users here).
 * `/`         — the manager Dashboard landing page (KPI tiles + graphs + recent
 *               activity), guarded by RequireAuth (auth) then SetupGuard (setup).
 * `/config`   — the operational config panel (authed + setup-complete).
 * `/users`    — the user-management page, admin-only (authed + setup-complete;
 *               the backend `GET|POST|DELETE /api/users` is admin-only too).
 * `/wizard`   — the 6-step first-run setup wizard (reachable directly, no auth —
 *               the first-run path has no token yet; the wizard creates the
 *               initial admin via setup-admin then logs in).
 * `/analytics` — the daily analytics dashboard + local `.xlsx` export
 *               (FR-ADM-03 / QUE-26), authed + setup-complete.
 *
 * The admin app is a config/wizard/analytics/dashboard tool, never a queue
 * monitor (SRP): it consumes only its API slice and never touches caller/kiosk/tv
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
 *
 * {@link AuthProvider} wraps the shell + routes so the current principal is
 * resolved once (a single `/api/auth/me` probe); {@link AppShell}'s profile
 * menu, {@link RequireAuth}, and {@link UsersPage} all read it from the shared
 * context. RequireAuth is composed outside SetupGuard: no token → `/login`
 * first, then incomplete setup → `/wizard` (auth first, then setup).
 */
export function App({ api }: { api?: IAdminAppApi } = {}) {
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
    <AuthProvider api={adminApi}>
      {/* AC8 — skip link for keyboard users; visually hidden until focused. */}
      <a href="#main-content" className="skip-link">
        Lewati ke konten
      </a>
      {/* AC8 — single <main> landmark per route (the AppShell owns it; the
          routed page owns the h1). The wizard/login routes bypass the shell so
          they keep their own full-width layout while the skip-link target +
          single-<main> landmark invariant still holds. */}
      <AppShell storeName={storeName}>
        <Routes>
          <Route path="/login" element={<LoginPage api={adminApi} />} />
          <Route path="/wizard" element={<WizardPage api={adminApi} />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <SetupGuard api={adminApi}>
                  <DashboardPage api={adminApi} />
                </SetupGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/config"
            element={
              <RequireAuth>
                <SetupGuard api={adminApi}>
                  <AdminPanel api={adminApi} />
                </SetupGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/analytics"
            element={
              <RequireAuth>
                <SetupGuard api={adminApi}>
                  <AnalyticsPage api={adminApi} />
                </SetupGuard>
              </RequireAuth>
            }
          />
          <Route
            path="/users"
            element={
              <RequireAuth>
                <SetupGuard api={adminApi}>
                  <UsersPage api={adminApi} />
                </SetupGuard>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AuthProvider>
  );
}