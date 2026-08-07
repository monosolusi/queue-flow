import { Navigate } from 'react-router-dom';
import { useSystemConfigContext } from '../config/system-config-context';
import { GuardError } from './GuardError';

/**
 * Post-setup block on `/wizard` (FR-WZD-01). The wizard is first-run only now:
 * once setup completes (or, equivalently, the visitor is logged in — the first
 * admin is created by the wizard, so "logged in" implies "setup complete" in
 * practice), `/wizard` is closed. The guard keys off `isInitialSetupCompleted`
 * from the shared store configuration, which covers both signals: setup-complete
 * AND logged-in both surface `true` here, so a logged-in manager who manually
 * navigates to `/wizard` is bounced to `/` instead of re-running the guided
 * setup. The wizard route stays reachable for a clean store (first-run path).
 *
 * Sibling of {@link SetupGuard}: both read the one config snapshot resolved by
 * `SystemConfigProvider` (no per-guard probe) and render a loading banner /
 * outage state / navigate decision. The two compose on disjoint route sets
 * (`SetupGuard` wraps the operational routes + `/login`, `WizardGuard` wraps
 * `/wizard`), so a clean browser hits `SetupGuard` first (operational route) →
 * redirect to `/wizard` → `WizardGuard` sees setup incomplete → render.
 *
 * The wizard's finalize calls the shared `refresh()` after a successful save, so
 * the post-setup snapshot lands here too — a back-navigation to `/wizard` right
 * after setup is correctly bounced instead of re-opening the guided setup
 * against a store that is already configured.
 *
 * **Failure mode:** a fetch failure is NOT treated as "setup incomplete" (the
 * read returns a default DTO on a clean store, never throws, so a rejection
 * means a real outage). The guard surfaces {@link GuardError} — do NOT redirect
 * on error, or a transient outage could loop with `SetupGuard` (which also shows
 * an error, never redirects on failure). The wizard only renders when setup is
 * CONFIRMED incomplete.
 */
export function WizardGuard({ children }: { children: React.ReactNode }) {
  const { config, loading, refresh } = useSystemConfigContext();

  if (config !== null) {
    return config.isInitialSetupCompleted ? <Navigate to="/" replace /> : <>{children}</>;
  }
  if (loading) {
    return <div className="guard-loading">Memuat konfigurasi sistem…</div>;
  }
  return <GuardError onRetry={() => void refresh()} />;
}
