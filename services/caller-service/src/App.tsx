import { useEffect, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CallerApi } from './api/caller-api';
import type { ICallerApi } from './api/caller-api';
import { AuthProvider } from './auth/useAuth';
import { RequireAuth } from './auth/RequireAuth';
import { applyBrandColor } from './lib/theme';
import { CounterSelectPage } from './pages/CounterSelectPage';
import { LoginPage } from './pages/LoginPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { useCounterBinding } from './state/counter-binding';
import { QueueStoreProvider } from './state/queue-store';

/**
 * Top-level routing. The caller panel is a single-user PWA on a staff device.
 * Auth (QUE-43) is resolved first via {@link RequireAuth} — an unauthenticated
 * user is redirected to the public `/login` route. Once authenticated, the
 * device-local counter binding drives navigation: no bound counter → `/`
 * (counter select); bound counter → `/workspace`. The binding is device-local
 * (localStorage) and PERSISTS across logout — a staff member re-logging in
 * keeps their bound counter.
 *
 * The manager-configured brand color (QUE-36) is applied to the runtime
 * `--accent` once on mount (QUE-37 AC6). The caller has no other config fetch,
 * so this is a dedicated top-level effect (a cheap single GET on a single-user
 * staff device). The static `#2563eb` default stays in place on failure (no
 * flash — it IS the default). The brand-color endpoint is public, so it
 * resolves on `/login` too (the login screen is themed with the store color).
 */
export function App({ api }: { api?: ICallerApi } = {}) {
  const callerApi = useMemo(() => api ?? new CallerApi(), [api]);
  const { bound, bind, unbind } = useCounterBinding();

  useEffect(() => {
    callerApi
      .getBrandColor()
      .then((c) => applyBrandColor(c.brandColor))
      .catch(() => {
        /* keep the static `#2563eb` default on fetch failure */
      });
  }, [callerApi]);

  return (
    <AuthProvider api={callerApi}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              {bound ? (
                <Navigate to="/workspace" replace />
              ) : (
                <CounterSelectPage api={callerApi} onChoose={bind} />
              )}
            </RequireAuth>
          }
        />
        <Route
          path="/workspace"
          element={
            <RequireAuth>
              {bound ? (
                <QueueStoreProvider bound={bound} api={callerApi}>
                  <WorkspacePage bound={bound} onUnbind={unbind} />
                </QueueStoreProvider>
              ) : (
                <Navigate to="/" replace />
              )}
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}