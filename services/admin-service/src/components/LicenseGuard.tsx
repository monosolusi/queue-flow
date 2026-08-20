import { Navigate } from 'react-router-dom';
import { useSystemConfigContext } from '../config/system-config-context';
import { GuardError } from './GuardError';

/**
 * Licence gate. The OUTERMOST guard on every route:
 * `<LicenseGuard><SetupGuard><RequireAuth>…</RequireAuth></SetupGuard></LicenseGuard>`.
 *
 * Licence before setup before auth, matching the gateway's `access-check`,
 * which answers the two gates in that order for the same reason: there is no
 * point configuring a store that is not licensed to run, and a first-run
 * visitor has no account to authenticate with.
 *
 * Reads the licence slice off the shared `GET /api/system/config` snapshot, so
 * wrapping every route adds no probes — the same reasoning that lets
 * {@link SetupGuard} wrap everything.
 *
 * **`license` absent is NOT "unlicensed".** It is `undefined` on a core-api
 * predating this feature and `null` during core-api's boot window, before the
 * first evaluation lands. Blocking on either would take a working store offline
 * over a deployment ordering detail, so both render the children. Only an
 * explicit `RESTRICTED` redirects — the same "absence of evidence is not
 * evidence" rule the host fingerprint follows.
 *
 * Branching on `config !== null` FIRST mirrors {@link SetupGuard}: a background
 * `refresh()` must not flash the loading state, and a failed refresh must keep
 * the last known config rather than dropping the manager onto an error screen.
 * A fetch failure is an outage, never an "unlicensed" signal, so it surfaces
 * {@link GuardError} instead of redirecting.
 *
 * This is the client-side half. The gateway `auth_request` covers `/kiosk/`,
 * `/tv/` and `/caller/` — which this SPA cannot reach — and core-api's
 * `APP_GUARD` is the half that actually withholds anything. This guard only
 * decides what the manager SEES.
 */
export function LicenseGuard({ children }: { children: React.ReactNode }) {
  const { config, loading, refresh } = useSystemConfigContext();

  if (config !== null) {
    const license = config.license;
    if (license != null && license.state === 'RESTRICTED') {
      return <Navigate to="/aktivasi" replace />;
    }
    return <>{children}</>;
  }
  if (loading) {
    return <div className="guard-loading">Memuat konfigurasi sistem…</div>;
  }
  return <GuardError onRetry={() => void refresh()} />;
}
