import { useEffect, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminAppApi } from './api/admin-api';
import { applyBrandColor, applyThemeMode } from './lib/theme';
import { SetupGuard } from './components/SetupGuard';
import { WizardGuard } from './components/WizardGuard';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/auth-context';
import { RequireAuth } from './auth/RequireAuth';
import { SystemConfigProvider, useSystemConfigContext } from './config/system-config-context';
import { AdminPanel } from './pages/AdminPanel';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { UsersPage } from './pages/UsersPage';
import { WizardPage } from './pages/WizardPage';

/**
 * Top-level routing for the admin panel + first-run wizard (FR-WZD-01..06).
 *
 * `/login`    — the manager sign-in page, guarded by SetupGuard only (no
 *               RequireAuth — this is where an unauthenticated user is sent).
 *               The setup guard is load-bearing here too: on a clean store a
 *               sign-in form would offer an account that does not exist yet,
 *               with no path to the wizard (the reported bug on another route),
 *               and the gateway `auth_request` exempts `/admin/` so nothing
 *               else catches it. No loop risk — `/wizard` is not setup-guarded.
 * `/`         — the manager Dashboard: **live operational status** (now-serving,
 *               waiting counts per category, counter active/idle), REST-polled
 *               (QUE-44), guarded by SetupGuard (setup) then RequireAuth (auth):
 *               a clean store (isInitialSetupCompleted === false) redirects to
 *               `/wizard`; once setup is complete, RequireAuth redirects a
 *               tokenless visitor to `/login`.
 * `/config`   — the operational config panel (setup-complete + authed).
 * `/users`    — the user-management page, admin-only (setup-complete + authed;
 *               the backend `GET|POST|DELETE /api/users` is admin-only too).
 * `/wizard`   — the 6-step first-run setup wizard, gated by WizardGuard
 *               (first-run only): once setup is complete (or the visitor is
 *               logged in — the first admin is created by the wizard, so
 *               "logged in" implies "setup complete"), `/wizard` redirects to
 *               `/`. The first-run path has no token yet; the wizard creates the
 *               initial admin via setup-admin then logs in.
 * `/analytics` — the **historical analytics** view (multi-day range trends,
 *               per-category/counter performance, local `.xlsx` export)
 *               (FR-ADM-03 / QUE-44), setup-complete + authed.
 * `/audit`    — the dedicated audit-log page (QUE-45), reusing
 *               `GET /api/audit/log`; the "Audit" group of the grouped left
 *               nav (QUE-45) resolves here. Setup-complete + authed.
 *
 * The admin app is a config/wizard/analytics/dashboard tool. QUE-44 expands it
 * into a read-only **operational monitor** for the live dashboard: it REST-polls
 * `GET /api/queue/board` + `GET /api/counters` (no WebSocket — polling keeps the
 * SRP/ISP boundary clean: read-only `IAdminApi`, no realtime participation, no
 * caller/kiosk/tv DTO leakage beyond the board + counters the dashboard reads).
 * It never owns a write/realtime surface. `api` is an optional prop so tests can
 * inject a fake without touching the network.
 *
 * **Two providers, two single-probe resolutions.** {@link AuthProvider} resolves
 * the current principal once (`GET /api/auth/me`) for {@link AppShell}'s profile
 * menu, {@link RequireAuth}, and {@link UsersPage}; {@link SystemConfigProvider}
 * resolves the store configuration once (`GET /api/system/config`) for
 * {@link SetupGuard}, {@link WizardGuard}, the shell's store-name chrome, the
 * runtime `--accent`/theme, and the dashboard's category labels. Both are shared
 * state rather than per-consumer fetches, so neither endpoint is probed more
 * than once per page load AND every consumer sees the same snapshot — a wizard
 * finalize or a store rename calls the provider's `refresh()` and the whole app
 * updates coherently instead of holding four divergent copies until a reload.
 *
 * **SetupGuard is composed OUTSIDE RequireAuth on every operational route
 * (`<SetupGuard><RequireAuth>…</RequireAuth></SetupGuard>`): setup first, then
 * auth.** A first-run visitor has no account, so the setup check must precede
 * the auth check or a clean visitor is bounced to `/login` with no way to create
 * an account (the reported bug). `/wizard` is gated by WizardGuard (first-run
 * only) — once setup completes, the wizard is closed and the store-name +
 * state-machine editing surfaces that used to live only in the wizard now live
 * in the operational `AdminPanel` (no functionality lost).
 */
export function App({ api }: { api?: IAdminAppApi } = {}) {
  const adminApi = useMemo(() => api ?? new AdminApi(), [api]);

  return (
    <AuthProvider api={adminApi}>
      <SystemConfigProvider api={adminApi}>
        <AppRoutes api={adminApi} />
      </SystemConfigProvider>
    </AuthProvider>
  );
}

/**
 * The routed tree. Split out of {@link App} because it CONSUMES the two contexts
 * `App` provides (a component cannot read a context it renders itself): it needs
 * the resolved configuration for the shell's store-name chrome, the dashboard's
 * category labels, and the app-wide theme side effects.
 */
function AppRoutes({ api }: { api: IAdminAppApi }) {
  const { config } = useSystemConfigContext();

  // The manager-configured brand color (QUE-36) + this service's light/dark mode
  // (QUE-47) are applied to the document as a side effect whenever the shared
  // configuration resolves or is refreshed, decoupling the app-wide theme from
  // the routed pages. Before it resolves — and on a fetch failure, when `config`
  // stays null — the static `--accent: #2563eb` + the `:root` light palette in
  // `_tokens.css` stay in place; they ARE the defaults, so there is no flash.
  useEffect(() => {
    if (config === null) return;
    applyBrandColor(config.brandColor);
    applyThemeMode(config.serviceThemes?.admin);
  }, [config]);

  return (
    <>
      {/* AC8 — skip link for keyboard users; visually hidden until focused. */}
      <a href="#main-content" className="skip-link">
        Lewati ke konten
      </a>
      {/* AC8 — single <main> landmark per route (the AppShell owns it; the
          routed page owns the h1). The wizard/login routes bypass the shell so
          they keep their own full-width layout while the skip-link target +
          single-<main> landmark invariant still holds. */}
      <AppShell storeName={config?.storeName}>
        <Routes>
          <Route
            path="/login"
            element={
              <SetupGuard>
                <LoginPage api={api} />
              </SetupGuard>
            }
          />
          <Route
            path="/wizard"
            element={
              <WizardGuard>
                <WizardPage api={api} />
              </WizardGuard>
            }
          />
          <Route
            path="/"
            element={
              <SetupGuard>
                <RequireAuth>
                  <DashboardPage api={api} config={config} />
                </RequireAuth>
              </SetupGuard>
            }
          />
          <Route
            path="/config"
            element={
              <SetupGuard>
                <RequireAuth>
                  <AdminPanel api={api} />
                </RequireAuth>
              </SetupGuard>
            }
          />
          <Route
            path="/analytics"
            element={
              <SetupGuard>
                <RequireAuth>
                  <AnalyticsPage api={api} />
                </RequireAuth>
              </SetupGuard>
            }
          />
          <Route
            path="/users"
            element={
              <SetupGuard>
                <RequireAuth>
                  <UsersPage api={api} />
                </RequireAuth>
              </SetupGuard>
            }
          />
          <Route
            path="/audit"
            element={
              <SetupGuard>
                <RequireAuth>
                  <AuditLogPage api={api} />
                </RequireAuth>
              </SetupGuard>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </>
  );
}
