import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import type { IAdminApi } from '../api/admin-api';

type GuardState =
  | { status: 'loading' }
  | { status: 'redirect' }
  | { status: 'ready' };

/**
 * First-run gate (FR-WZD-01). Fetches `GET /api/system/config` and, when the
 * store is not yet configured (`isInitialSetupCompleted === false`),
 * client-redirects to `/wizard`. The read endpoint returns a default DTO on a
 * clean store (it does NOT throw `SYSTEM_NOT_CONFIGURED`), so a clean browser
 * hitting the admin panel is redirected to the wizard instead of seeing an
 * error. The guard renders its children only once setup is complete.
 *
 * Chosen over NGINX auth_request/lua routing: one HTTP call, no gateway logic
 * — the cleanest fit for an offline single-host deployment (NFR-REL-01).
 */
export function SetupGuard({ api, children }: { api: IAdminApi; children: React.ReactNode }) {
  const [state, setState] = useState<GuardState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api
      .getSystemConfig()
      .then((config) => {
        if (cancelled) return;
        setState(config.isInitialSetupCompleted ? { status: 'ready' } : { status: 'redirect' });
      })
      .catch(() => {
        // If the config read fails (core-api down / network), do NOT silently
        // drop the user into the panel. Treat the failure as "not configured"
        // so the wizard can run (or surface the error) rather than an empty
        // admin screen.
        if (!cancelled) setState({ status: 'redirect' });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (state.status === 'loading') {
    return <div className="guard-loading">Memuat konfigurasi sistem…</div>;
  }
  if (state.status === 'redirect') {
    return <Navigate to="/wizard" replace />;
  }
  return <>{children}</>;
}