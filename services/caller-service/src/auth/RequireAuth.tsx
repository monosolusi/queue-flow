import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './useAuth';

type GuardState =
  | { status: 'loading' }
  | { status: 'redirect' }
  | { status: 'ready' };

/**
 * Route guard for the authenticated caller workspace (QUE-43). Mirrors the
 * admin-service SetupGuard loading/redirect/ready state machine: while the
 * auth user is being resolved (loading) it shows a status message; once
 * resolved, an authenticated user renders the children and a missing user
 * redirects to the public `/login` route. The bound-counter cascade lives in
 * App.tsx under this guard — auth is resolved first, then the device-local
 * counter binding picks `/` (counter select) vs `/workspace`.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const state: GuardState = loading
    ? { status: 'loading' }
    : user
      ? { status: 'ready' }
      : { status: 'redirect' };

  if (state.status === 'loading') {
    return <div className="guard-loading">Memuat sesi…</div>;
  }
  if (state.status === 'redirect') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}