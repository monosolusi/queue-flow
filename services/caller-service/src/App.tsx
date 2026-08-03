import { useEffect, useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CallerApi } from './api/caller-api';
import type { ICallerApi } from './api/caller-api';
import { applyBrandColor } from './lib/theme';
import { CounterSelectPage } from './pages/CounterSelectPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { useCounterBinding } from './state/counter-binding';
import { QueueStoreProvider } from './state/queue-store';

/**
 * Top-level routing. The caller panel is a single-user PWA on a staff device:
 * no bound counter → / (counter select); bound counter → /workspace.
 * The binding is device-local (localStorage), so navigation is derived from it
 * rather than from server auth.
 *
 * The manager-configured brand color (QUE-36) is applied to the runtime
 * `--accent` once on mount (QUE-37 AC6). The caller has no other config fetch,
 * so this is a dedicated top-level effect (a cheap single GET on a single-user
 * staff device). The static `#2563eb` default stays in place on failure (no
 * flash — it IS the default).
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
    <Routes>
      <Route
        path="/"
        element={
          bound ? (
            <Navigate to="/workspace" replace />
          ) : (
            <CounterSelectPage api={callerApi} onChoose={bind} />
          )
        }
      />
      <Route
        path="/workspace"
        element={
          bound ? (
            <QueueStoreProvider bound={bound} api={callerApi}>
              <WorkspacePage bound={bound} onUnbind={unbind} />
            </QueueStoreProvider>
          ) : (
            <Navigate to="/" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}