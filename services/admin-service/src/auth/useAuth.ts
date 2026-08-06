import { useCallback, useEffect, useRef, useState } from 'react';
import type { IAuthApi } from '../api/admin-api';
import type { AuthUserDto } from '../api/types';
import { clearToken, readToken, UNAUTHORIZED_EVENT } from './token-store';

export interface AuthState {
  /** The authenticated principal, or `null` when no session / 401. */
  readonly user: AuthUserDto | null;
  /** `true` while the initial `/me` probe is in flight. */
  readonly loading: boolean;
  /** Re-resolve the current user from `/api/auth/me` (after login, or to
   *  refresh role). No-op resolves to `null` when there is no token. */
  readonly refresh: () => Promise<void>;
  /** Best-effort `POST /api/auth/logout` + clear the local session. Always
   *  drops the cached user regardless of the server call's outcome. */
  readonly logout: () => Promise<void>;
}

/**
 * Resolves + holds the authenticated principal (QUE-43). The hook is the single
 * auth state owner: on mount it probes `/api/auth/me` when a token is stored,
 * and it listens for the `qms:unauthorized` window event (dispatched by
 * `admin-api.ts` when a protected request fails with 401) to drop its cached
 * user so {@link RequireAuth} redirects to `/login`.
 *
 * The client never decodes the token (no JWT lib — NFR-REL-01); it stores it
 * (`token-store`), sends it (`admin-api`), and reads `/me` for the user. `refresh`
 * is the post-login re-probe: {@link LoginPage} calls `api.login` then
 * `writeToken` then `await refresh()` so the provider re-resolves the user
 * before navigating to `/`.
 */
export function useAuth(api: IAuthApi): AuthState {
  const [user, setUser] = useState<AuthUserDto | null>(null);
  const [loading, setLoading] = useState<boolean>(() => readToken() !== null);
  // Keep the api in a ref so the unauthorized-event listener (attached once)
  // always reads the latest api without re-subscribing on every render.
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    if (!readToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const me = await apiRef.current.getMe();
      setUser(me);
    } catch {
      // 401 already cleared the token + dispatched the event; just drop the
      // cached user. Any other failure (network) leaves the token in place —
      // the user stays logged in for this session.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRef.current.logout();
    } catch {
      /* best-effort — local logout proceeds regardless */
    } finally {
      clearToken();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    // Initial probe only when a token is stored (no point calling /me pre-login).
    if (readToken() !== null) {
      void refresh();
    }
    // Drop the cached user when any protected request rejects with 401 (session
    // expired mid-session) — RequireAuth then redirects to /login.
    function onUnauthorized() {
      setUser(null);
      setLoading(false);
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  return { user, loading, refresh, logout };
}