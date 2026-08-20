import { useEffect, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminApi } from './api/admin-api';
import type { IAdminAppApi } from './api/admin-api';
import { applyBrandColor, applyThemeMode } from './lib/theme';
import { LicenseGuard } from './components/LicenseGuard';
import { SetupGuard } from './components/SetupGuard';
import { WizardGuard } from './components/WizardGuard';
import { AppShell } from './components/AppShell';
import { AuthProvider } from './auth/auth-context';
import { RequireAuth } from './auth/RequireAuth';
import { SystemConfigProvider, useSystemConfigContext } from './config/system-config-context';
import { ToastProvider } from './toast/toast-context';
import { AdminPanel } from './pages/AdminPanel';
import { AktivasiPage } from './pages/AktivasiPage';
import { AlurStatusDesigner } from './pages/AlurStatusDesigner';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { DashboardPage } from './pages/DashboardPage';
import { LisensiPage } from './pages/LisensiPage';
import { LoginPage } from './pages/LoginPage';
import { PrinterConfigPage } from './pages/PrinterConfigPage';
import { TtsConfigPage } from './pages/TtsConfigPage';
import { TvLayoutPage } from './pages/TvLayoutPage';
import { UsersPage } from './pages/UsersPage';
import { WizardPage } from './pages/WizardPage';
import { ConfigDraftProvider } from './pages/admin-config/config-draft-context';

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
 * `/config`   — the operational config panel (setup-complete + authed). A nested
 *               route group whose element is a `ConfigDraftProvider` (owns the
 *               shared mutable draft + `save()`), rendering `<Outlet/>` with one
 *               child route per config section (generalizing the
 *               `/config/alur-status` pattern — the in-content tablist was
 *               consolidated into the sidebar):
 *                 `/config`             → index redirect to `/config/profil`.
 *                 `/config/profil`      → Profil & Tampilan (store name + brand
 *                                         color + per-service themes).
 *                 `/config/kategori`    → Kategori.
 *                 `/config/counter-routing` → Counter & Routing.
 *                 `/config/reset-harian` → Reset Harian.
 *                 `/config/operasi-manual` → Operasi Manual.
 *                 `/config/alur-status` → the full-page Alur Status Tiket
 *                                         diagram designer (large canvas +
 *                                         read-only JSON source view). The provider stays
 *                 mounted across all `/config/*` URLs, so the draft + a
 *                 cross-section edit ride ONE full-payload save and navigation
 *                 loses no edits.
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
 * **{@link ToastProvider} is composed INNERMOST, and it renders the notification
 * viewport itself.** Innermost because it depends on neither auth nor config —
 * wrapping it outside either would put a third provider between them and their
 * consumers for no reason and risk perturbing their probe-once semantics. Above
 * `<Routes>` so a toast raised by a write survives the navigation that often
 * follows it (a logout failure must stay readable after the redirect). The
 * provider owning the viewport is what makes "is the provider mounted?" the only
 * thing a page can get wrong — and the context's no-op default covers even that,
 * so a page rendered in isolation drops its notifications rather than crashing.
 *
 * The viewport therefore lands OUTSIDE `<main id="main-content">`: {@link AppShell}
 * renders a bare `<main>` for `/wizard` and `/login`, so mounting the viewport
 * inside the shell would either bury a global live region inside the page
 * landmark or drop it entirely on those two routes. Keeping it a sibling
 * preserves the single-`<main>` invariant (AC8) and gives wizard/login toasts
 * for free.
 *
 * **Every operational route is wrapped in {@link Gated}: license -> setup ->
 * auth, outermost first.** A first-run visitor has no account, so the setup
 * check must precede the auth check or a clean visitor is bounced to `/login`
 * with no way to create an account (the reported bug). The license check
 * precedes both, matching the gateway's `access-check`: there is no point
 * configuring a store that is not licensed to run. `/wizard` is gated by WizardGuard (first-run
 * only) — once setup completes, the wizard is closed and the store-name +
 * state-machine editing surfaces that used to live only in the wizard now live
 * in the operational `AdminPanel` (no functionality lost).
 */
export function App({ api }: { api?: IAdminAppApi } = {}) {
  const adminApi = useMemo(() => api ?? new AdminApi(), [api]);

  return (
    <AuthProvider api={adminApi}>
      <SystemConfigProvider api={adminApi}>
        <ToastProvider>
          <AppRoutes api={adminApi} />
        </ToastProvider>
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
/**
 * The full gate stack, in the one order that works: **license -> setup -> auth**.
 *
 * License first because there is no point configuring a store that is not
 * licensed to run. Setup before auth because a first-run visitor has no account
 * — reversing those two bounces a clean browser to `/login` with no way to
 * create one (a bug this repo has already had once). The gateway's
 * `access-check` answers the same two gates in the same order.
 *
 * Extracted because it was repeated on every operational route; a third level
 * nested by hand ten times is nine chances to get the order wrong.
 */
function Gated({ children }: { children: React.ReactNode }) {
  return (
    <LicenseGuard>
      <SetupGuard>
        <RequireAuth>{children}</RequireAuth>
      </SetupGuard>
    </LicenseGuard>
  );
}

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
          {/* Deliberately ungated. LicenseGuard sends a restricted store HERE,
              so guarding it would loop; and SetupGuard would divert an
              unlicensed-and-unconfigured store to /wizard, which it is not yet
              allowed to complete. This page must work with no license, no
              config and no account — that is the whole point of it. */}
          <Route path="/aktivasi" element={<AktivasiPage api={api} />} />
          <Route
            path="/login"
            element={
              <LicenseGuard>
                <SetupGuard>
                  <LoginPage api={api} />
                </SetupGuard>
              </LicenseGuard>
            }
          />
          <Route
            path="/wizard"
            element={
              <LicenseGuard>
                <WizardGuard>
                  <WizardPage api={api} />
                </WizardGuard>
              </LicenseGuard>
            }
          />
          <Route
            path="/"
            element={
              <Gated>
                <DashboardPage api={api} config={config} />
              </Gated>
            }
          />
          <Route
            path="/config"
            element={
              <Gated>
                <ConfigDraftProvider api={api} />
              </Gated>
            }
          >
            <Route index element={<Navigate to="profil" replace />} />
            <Route path="profil" element={<AdminPanel section="profile" />} />
            <Route path="kategori" element={<AdminPanel section="categories" />} />
            <Route path="counter-routing" element={<AdminPanel section="routing" />} />
            <Route path="reset-harian" element={<AdminPanel section="daily-reset" />} />
            <Route path="operasi-manual" element={<AdminPanel section="manual" />} />
            <Route path="alur-status" element={<AlurStatusDesigner />} />
          </Route>
          <Route
            path="/tv-layout"
            element={
              <Gated>
                <TvLayoutPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/printer-config"
            element={
              <Gated>
                <PrinterConfigPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/tts-config"
            element={
              <Gated>
                <TtsConfigPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/analytics"
            element={
              <Gated>
                <AnalyticsPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/users"
            element={
              <Gated>
                <UsersPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/lisensi"
            element={
              <Gated>
                <LisensiPage api={api} />
              </Gated>
            }
          />
          <Route
            path="/audit"
            element={
              <Gated>
                <AuditLogPage api={api} />
              </Gated>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </>
  );
}
