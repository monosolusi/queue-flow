import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ICallerApi, InvalidCredentialsError } from '../api/caller-api';
import type { AuthUserDto } from '../api/types';
import { clearToken, writeToken } from './token-store';

/**
 * Auth state for the caller panel (QUE-43). Resolved once on mount via
 * `GET /api/auth/me`; the user is `null` until that resolves (loading), then
 * either the resolved user or `null` (no token / 401 / network failure). The
 * {@link RequireAuth} guard consumes `user`/`loading` and redirects to /login
 * when there is no authenticated user; the workspace header consumes `user`
 * for the username display + `logout` for the "Keluar" action.
 *
 * `login` stores the token (returned by the login endpoint) and sets the user
 * in one transition — no extra `getMe` round-trip. `logout` calls the
 * idempotent server logout, clears the token (NOT the device-local counter
 * binding), and nulls the user; the {@link RequireAuth} guard then redirects
 * to /login.
 */
export interface AuthContextValue {
  readonly user: AuthUserDto | null;
  readonly loading: boolean;
  /** Authenticate + persist the token. Rejects with
   *  {@link InvalidCredentialsError} on 401 (invalid credentials). */
  readonly login: (username: string, password: string) => Promise<void>;
  /** Server logout (idempotent) + clear the token. The counter binding is
   *  preserved (device-local, persists across logout). */
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  readonly api: ICallerApi;
  readonly children: ReactNode;
}

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve the signed-in user once on mount (and when the api identity
  // changes — a test swapping in a new fake). A missing/expired token resolves
  // null without throwing so the guard redirects gracefully.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getMe()
      .then((u) => {
        if (!cancelled) {
          setUser(u);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await api.login(username, password);
      writeToken(res.token);
      setUser(res.user);
    },
    [api],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* server logout is idempotent/best-effort */
    }
    clearToken();
    setUser(null);
  }, [api]);

  const value = useMemo<AuthContextValue>(() => ({ user, loading, login, logout }), [
    user,
    loading,
    login,
    logout,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}