/**
 * Opaque bearer-token store for the admin session (QUE-43). The token is the
 * sole auth credential the client holds — it never decodes it (no JWT lib —
 * NFR-REL-01), it just stores it, sends it as `Authorization: Bearer <token>`,
 * and reads `/api/auth/me` for the current user.
 *
 * Mirrors the `services/caller-service/src/state/counter-binding.ts` localStorage
 * pattern: a `try/catch` around every storage op so private-mode browsers (or
 * disabled storage) degrade gracefully — the token just won't persist across
 * reloads, but the in-memory session still drives the UI. The key is admin-
 * scoped (`qms.admin.token`) so a device that also runs the caller PWA does not
 * collide.
 *
 * A per-service leaf utility (not synced) — matches the `theme.ts` duplication
 * precedent: a tiny leaf duplicated per service is less over-engineering than a
 * shared/synced module crossing the standalone-service boundary (NFR-MNT-02).
 */

const STORAGE_KEY = 'qms.admin.token';

/**
 * The window event the API layer dispatches when a protected request fails with
 * 401 (session expired / token rejected). The {@link AuthProvider} listens for
 * it and drops its cached user so {@link RequireAuth} redirects to `/login`. A
 * `CustomEvent` (not a bare `Event`) so the dispatch carries no payload but stays
 * distinguishable from other window events. Decoupling the redirect from the
 * API layer keeps `admin-api.ts` free of router knowledge.
 */
export const UNAUTHORIZED_EVENT = 'qms:unauthorized';

/** Reads the stored bearer token, or `null` when none / unreadable. */
export function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private mode); treat as no token.
    return null;
  }
}

/** Persists the bearer token (overwrites any prior). No-op on storage failure. */
export function writeToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // private mode / quota — the token won't persist across reloads; the
    // in-memory auth state still drives the UI for this session.
  }
}

/** Removes the stored bearer token. No-op on storage failure. */
export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode — nothing to remove; the in-memory auth state is dropped
    // by the caller regardless.
  }
}