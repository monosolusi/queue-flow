import { Navigate } from 'react-router-dom';
import { useSystemConfigContext } from '../config/system-config-context';
import { GuardError } from './GuardError';

/**
 * First-run gate (FR-WZD-01). Reads the shared store configuration and, when the
 * store is not yet configured (`isInitialSetupCompleted === false`),
 * client-redirects to `/wizard`. `GET /api/system/config` returns a default DTO
 * on a clean store (it does NOT throw `SYSTEM_NOT_CONFIGURED`), so a clean
 * browser hitting the admin panel is redirected to the wizard instead of seeing
 * an error. The guard renders its children only once setup is complete.
 *
 * **Guard precedence (load-bearing):** in {@link App} this is the OUTER guard
 * on every operational route (`<SetupGuard><RequireAuth>…</RequireAuth></SetupGuard>` —
 * setup first, then auth). A first-run visitor has no account, so the setup
 * check must precede the auth check or a clean visitor is bounced to `/login`
 * with no way to create an account (the reported bug). Setup incomplete →
 * `/wizard` regardless of token; setup complete → `RequireAuth` decides.
 * `/login` is wrapped too: a clean store must not render a sign-in form for an
 * account that does not exist yet (the same bug on another route — the gateway
 * `auth_request` exempts `/admin/`, so nothing else catches it). There is no
 * loop risk: `/wizard` is gated by {@link WizardGuard}, not by this guard.
 *
 * The guard reads the config from the shared {@link useSystemConfigContext}
 * (resolved once by `SystemConfigProvider`), so wrapping every operational route
 * does not multiply `GET /api/system/config` probes — the same precedent
 * {@link RequireAuth} follows for `/me`. Branching on `config !== null` FIRST is
 * deliberate: a post-save `refresh()` re-reads in the background without
 * flashing the loading banner (which would unmount the page mid-save), and a
 * refresh that fails keeps the last known config instead of dropping a working
 * session onto an error screen.
 *
 * **Failure mode:** a fetch failure (core-api down / network) is NOT a
 * "not configured" signal, so the guard surfaces {@link GuardError} (Indonesian
 * copy + a "Coba Lagi" retry) instead of redirecting — see that component.
 *
 * Progressive enhancement alongside the gateway `auth_request` first-run guard
 * (QUE-13), NOT a replacement for it. The gateway guard is the primary gate
 * (PRD "semua akses HTTP" → `/wizard`): it covers the operational PWA routes
 * (`/kiosk/`, `/tv/`, `/caller/`) — which this SPA cannot reach — by probing
 * `GET /api/system/setup-status` and 302-redirecting to `/admin/wizard` when
 * unset. This SPA guard only covers the `/admin/` routes it wraps (the gateway
 * intentionally does not guard `/admin/` so the wizard SPA can load to perform
 * setup); it is a client-side fallback for those.
 */
export function SetupGuard({ children }: { children: React.ReactNode }) {
  const { config, loading, refresh } = useSystemConfigContext();

  if (config !== null) {
    return config.isInitialSetupCompleted ? <>{children}</> : <Navigate to="/wizard" replace />;
  }
  if (loading) {
    return <div className="guard-loading">Memuat konfigurasi sistem…</div>;
  }
  return <GuardError onRetry={() => void refresh()} />;
}
