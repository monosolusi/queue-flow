import { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CallerApi } from './api/caller-api';
import type { ICallerApi } from './api/caller-api';
import { CounterSelectPage } from './pages/CounterSelectPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { useCounterBinding } from './state/counter-binding';
import { QueueStoreProvider } from './state/queue-store';

/**
 * Top-level routing. The caller panel is a single-user PWA on a staff device:
 * no bound counter → / (counter select); bound counter → /workspace.
 * The binding is device-local (localStorage), so navigation is derived from it
 * rather than from server auth.
 */
export function App({ api }: { api?: ICallerApi } = {}) {
  const callerApi = useMemo(() => api ?? new CallerApi(), [api]);
  const { bound, bind, unbind } = useCounterBinding();

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