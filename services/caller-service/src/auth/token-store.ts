/**
 * Persists the caller-panel bearer token in `localStorage` (key
 * `qms.caller.token`). The client stores + sends the token and resolves the
 * user via `GET /api/auth/me`; it never decodes the JWT (no JWT lib — NFR-REL-01
 * keeps the bundle offline). `try/catch` tolerates private mode where
 * `localStorage` throws — the in-memory auth state still drives the UI for the
 * session, the token just won't persist across reloads (mirrors the
 * counter-binding leaf pattern).
 *
 * Deliberately separate from the counter-binding store (`qms.caller.counterBinding`):
 * the counter binding is device-local and PERSISTS across logout — a staff
 * member re-logging in keeps their bound counter. `clearToken` touches only
 * the token key, never the counter binding.
 */
const TOKEN_KEY = 'qms.caller.token';

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // localStorage may be unavailable (private mode); the token won't persist —
    // the in-memory auth state still drives the UI for this session.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // No-op when localStorage is unavailable (private mode).
  }
}