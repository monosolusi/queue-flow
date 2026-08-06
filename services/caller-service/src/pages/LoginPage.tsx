import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { InvalidCredentialsError } from '../api/caller-api';
import { useAuth } from '../auth/useAuth';

type SubmitState = 'idle' | 'submitting';

/**
 * Public login route (QUE-43). Staff authenticate with username/password;
 * on success the bearer token is persisted and the app navigates to `/`,
 * where {@link RequireAuth} resolves the now-authenticated user and the
 * bound-counter cascade routes to the counter select or workspace. A 401
 * (invalid credentials) surfaces an inline `role="alert"` message — the login
 * endpoint never triggers the authed-fetch 401 redirect (it uses its own
 * fetch path), so bad credentials are shown in place rather than reloading.
 *
 * Touch-surface double-tap guard: a synchronous `pendingRef` flip before the
 * first `await` prevents two same-tick submits from both firing the mutation
 * (the `disabled` affordance only takes effect after a re-render).
 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const pendingRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) {
      return; // synchronous double-tap guard
    }
    pendingRef.current = true;
    setSubmitState('submitting');
    setError(null);
    try {
      await login(username, password);
      navigate('/');
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        setError('Username atau kata sandi salah');
      } else {
        setError('Gagal masuk. Periksa koneksi ke server.');
      }
    } finally {
      pendingRef.current = false;
      setSubmitState('idle');
    }
  }

  const submitting = submitState === 'submitting';

  return (
    <main className="login">
      <form className="login__form" onSubmit={handleSubmit} noValidate>
        <h1 className="login__title">Masuk Caller Panel</h1>
        <p className="login__hint">Gunakan akun staff yang diberikan manajer.</p>

        <div className="login__field">
          <label htmlFor="login-username" className="login__label">
            Username
          </label>
          <input
            id="login-username"
            name="username"
            type="text"
            className="login__input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            disabled={submitting}
          />
        </div>

        <div className="login__field">
          <label htmlFor="login-password" className="login__label">
            Kata Sandi
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            className="login__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={submitting}
          />
        </div>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn--primary login__submit" disabled={submitting}>
          {submitting ? 'Memproses…' : 'Masuk'}
        </button>
      </form>
    </main>
  );
}