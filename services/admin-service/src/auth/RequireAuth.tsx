import { Navigate } from 'react-router-dom';
import { useAuthContext } from './auth-context';

type GuardState =
  | { status: 'loading' }
  | { status: 'redirect' }
  | { status: 'ready' };

/**
 * Authentication gate (QUE-43). The sibling of {@link SetupGuard} for the
 * authenticated principal: while the {@link AuthProvider} probes `/api/auth/me`
 * it shows a loading state; once resolved, a `null` user redirects to `/login`
 * and a resolved user renders the children. Mirrors SetupGuard's
 * loading/redirect/ready state machine so the two guards compose uniformly —
 * {@link App} nests them: `<RequireAuth><SetupGuard>…</SetupGuard></RequireAuth>`
 * (auth first — no token → login — then setup — incomplete → wizard).
 *
 * The guard reads auth state from the shared {@link useAuthContext} (resolved
 * once by {@link AuthProvider}), so wrapping multiple routes does not multiply
 * `/me` probes. `/login` and `/wizard` are public routes (not wrapped): the
 * first-run wizard must be reachable with no token, and login is where an
 * unauthenticated user is sent. The gateway `auth_request` first-run guard is
 * the primary redirect to `/wizard` on a clean store; this is the client-side
 * progressive-enhancement gate for the operational routes.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthContext();

  // While the initial /me probe is in flight (a token was stored but not yet
  // resolved), defer the redirect decision so a logged-in manager reloading /
  // deep-linking an operational route is not bounced to /login by the brief
  // null-user window before /me resolves.
  const state: GuardState = loading
    ? { status: 'loading' }
    : user === null
      ? { status: 'redirect' }
      : { status: 'ready' };

  if (state.status === 'loading') {
    return <div className="guard-loading">Memuat sesi…</div>;
  }
  if (state.status === 'redirect') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}