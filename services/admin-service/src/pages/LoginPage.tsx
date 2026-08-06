import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IAuthApi } from '../api/admin-api';
import { useAuthContext } from '../auth/auth-context';
import { writeToken } from '../auth/token-store';

/**
 * The manager sign-in page (QUE-43). A public route — the only authed surface
 * reachable without a token, and the destination {@link RequireAuth} sends an
 * unauthenticated user to. On submit it calls `api.login`, stores the bearer
 * token (`token-store`), then `refresh()` so the {@link AuthProvider} re-resolves
 * the principal before navigating to `/` — the operational routes are wrapped in
 * {@link RequireAuth}, so navigating before the user resolves would bounce back
 * here. A 401 (`INVALID_CREDENTIALS`) surfaces an inline Indonesian error
 * (aria-live); the login endpoint's 401 is NOT a session-expiry 401, so the API
 * layer does not fire the unauthorized redirect here.
 *
 * The page renders inside {@link AppShell} (which bypasses the sidebar/topbar
 * chrome on `/login`, mirroring `/wizard`) so the single `<main>` landmark +
 * skip-link invariant (AC8) holds on this route too. The page owns its `<h1>`.
 */
export function LoginPage({ api }: { api: IAuthApi }) {
  const navigate = useNavigate();
  const { refresh } = useAuthContext();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { token } = await api.login(username.trim(), password);
      writeToken(token);
      // Re-resolve the principal before navigating so RequireAuth (which gates
      // `/`) sees a non-null user and does not bounce back to /login.
      await refresh();
      navigate('/', { replace: true });
    } catch {
      setError('Username atau kata sandi salah');
      setSubmitting(false);
    }
  }

  const canSubmit = username.trim().length > 0 && password.length > 0 && !submitting;

  return (
    <div className="login">
      <form className="login__form" onSubmit={onSubmit} noValidate>
        <h1 className="login__title">Masuk Admin</h1>
        <p className="login__subtitle">Silakan masuk untuk mengelola sistem antrian.</p>

        <label className="field" htmlFor="login-username">
          <span className="field__label">Username</span>
          <input
            id="login-username"
            className="field__input"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </label>

        <label className="field" htmlFor="login-password">
          <span className="field__label">Kata sandi</span>
          <input
            id="login-password"
            className="field__input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && (
          <p className="login__error" role="alert" data-testid="login-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          className="btn btn--primary login__submit"
          disabled={!canSubmit}
          aria-busy={submitting}
          data-testid="login-submit"
        >
          {submitting ? 'Memproses…' : 'Masuk'}
        </button>
      </form>
    </div>
  );
}