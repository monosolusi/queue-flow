import { createContext, useContext, type ReactNode } from 'react';
import type { IAuthApi } from '../api/admin-api';
import { useAuth, type AuthState } from './useAuth';

/**
 * Shared auth state for the admin app (QUE-43). The {@link AuthProvider} wraps
 * the shell + routes and resolves the current user once via {@link useAuth};
 * {@link AppShell} (the profile menu), {@link RequireAuth} (the route guard),
 * and {@link UsersPage} (the self-delete guard) all consume it so `/me` is
 * probed exactly once per page load (a redundant cheap GET on a single-user
 * manager device — the same precedent as the brand-color fetch).
 *
 * The default value lets a consumer render in isolation with a null user + no-op
 * handlers, so the presentational fallback ("Manajer") stays assertable without
 * wiring the provider. {@link WizardPage} is the live witness — its spec renders
 * the page (which calls `useAuthContext`) with no provider. `AppShell.test.tsx`
 * no longer reaches this default: it module-mocks `useAuthContext` so it can
 * inject a rejecting `logout` and exercise the shell's failure path.
 */
const AuthContext = createContext<AuthState>({
  user: null,
  loading: false,
  refresh: async () => {},
  logout: async () => {},
});

export function AuthProvider({ api, children }: { api: IAuthApi; children: ReactNode }) {
  const auth = useAuth(api);
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

/** The current auth state. Components must be inside an {@link AuthProvider}. */
export function useAuthContext(): AuthState {
  return useContext(AuthContext);
}