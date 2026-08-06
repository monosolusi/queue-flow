import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { IUsersApi } from '../api/admin-api';
import type { UserDto, UserRole } from '../api/types';
import { useAuthContext } from '../auth/auth-context';
import { USER_ROLE_DESCRIPTIONS, USER_ROLE_LABELS } from '../lib/labels';

/** Username invariant mirror (QUE-43 — mirrors core-api's `Username` VO). */
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const PASSWORD_MIN = 8;
const ROLES: readonly UserRole[] = ['admin', 'caller-staff'];

/** One row of the create-user form, reset to blanks after a successful create. */
interface CreateForm {
  username: string;
  password: string;
  role: UserRole;
}

function emptyForm(): CreateForm {
  return { username: '', password: '', role: 'caller-staff' };
}

/**
 * Validates the create-user form, mirroring the backend `Username` / password
 * invariants so the form never submits a shape the backend would 400. Returns a
 * list of Indonesian error strings; empty means valid. Mirrors the wizard's
 * per-step validation pattern (one error list drives both the inline UI and the
 * submit guard).
 */
function validateCreate(form: CreateForm): string[] {
  const errors: string[] = [];
  if (!USERNAME_RE.test(form.username)) {
    errors.push('Username 3–32 karakter (huruf, angka, titik, garis bawah, strip).');
  }
  if (form.password.length < PASSWORD_MIN) {
    errors.push(`Kata sandi minimal ${PASSWORD_MIN} karakter.`);
  }
  return errors;
}

/**
 * The user-management page (QUE-43, `/users`). Admin-only: the route is wrapped
 * in {@link RequireAuth}, and the backend `GET /api/users` / `POST /api/users` /
 * `DELETE /api/users/:id` are admin-only (Bearer); a non-admin caller-staff who
 * reaches this page sees an access-denied notice (progressive enhancement — the
 * backend 403 is the authority). Lists every account with its friendly role
 * label, lets the manager create a new account (username/password/role), and
 * delete one with an inline two-step confirm. Self-delete is blocked
 * client-side (compare the current principal's id from {@link useAuthContext})
 * — the backend's last-admin guard (400) is the safety net for the admin role
 * itself.
 */
export function UsersPage({ api }: { api: IUsersApi }) {
  const { user: me } = useAuthContext();
  const [users, setUsers] = useState<readonly UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<CreateForm>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const isAdmin = me?.role === 'admin';

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const createErrors = useMemo(() => validateCreate(form), [form]);
  const canCreate = createErrors.length === 0 && !creating;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await api.createUser(form);
      setForm(emptyForm());
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await api.deleteUser(id);
      setConfirmingId(null);
      await reload();
    } catch (err) {
      // The backend guards the last admin with 400; surface the message so the
      // manager sees why the delete was refused.
      setError(err instanceof Error ? err.message : String(err));
      setConfirmingId(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="users users--denied">
        <h1 className="users__title">Pengguna</h1>
        <p className="users__error" role="alert" data-testid="users-denied">
          Akses ditolak. Halaman ini hanya untuk administrator.
        </p>
      </div>
    );
  }

  return (
    <div className="users">
      <header className="users__header">
        <h1 className="users__title">Pengguna</h1>
        <p className="users__subtitle">Kelola akun administrator dan staf loket.</p>
      </header>

      {error && (
        <p className="users__error" role="alert" data-testid="users-error">
          {error}
        </p>
      )}

      <section className="users__create" data-testid="users-create">
        <h2 className="users__section-title">Tambah Pengguna</h2>
        <form className="users__form" onSubmit={onCreate} noValidate>
          <label className="field" htmlFor="create-username">
            <span className="field__label">Username</span>
            <input
              id="create-username"
              className="field__input"
              type="text"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
              aria-required="true"
              aria-describedby={createErrors.length > 0 ? 'create-errors' : undefined}
              aria-invalid={createErrors.length > 0}
            />
          </label>
          <label className="field" htmlFor="create-password">
            <span className="field__label">Kata sandi</span>
            <input
              id="create-password"
              className="field__input"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
              aria-required="true"
              aria-describedby={createErrors.length > 0 ? 'create-errors' : undefined}
            />
          </label>
          <div className="field">
            <label className="field__label" htmlFor="create-role">
              Peran
            </label>
            <select
              id="create-role"
              className="field__input"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              aria-describedby="create-role-desc"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {USER_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <span className="field__hint" id="create-role-desc">
              {USER_ROLE_DESCRIPTIONS[form.role]}
            </span>
          </div>
          {createErrors.length > 0 && (
            <ul className="wizard__errors" id="create-errors" data-testid="create-errors">
              {createErrors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          )}
          <button
            type="submit"
            className="btn btn--primary"
            disabled={!canCreate}
            aria-busy={creating}
            data-testid="create-submit"
          >
            {creating ? 'Menambah…' : 'Tambah Pengguna'}
          </button>
        </form>
      </section>

      <section className="users__list" data-testid="users-list">
        <h2 className="users__section-title">Daftar Pengguna</h2>
        {loading ? (
          <p className="users__hint" data-testid="users-loading">
            Memuat daftar pengguna…
          </p>
        ) : users.length === 0 ? (
          <p className="users__hint">Belum ada pengguna.</p>
        ) : (
          <table className="users__table">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Peran</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = me?.id === u.id;
                return (
                  <tr key={u.id} data-testid={`user-row-${u.id}`}>
                    <td data-testid={`user-username-${u.id}`}>{u.username}</td>
                    <td>
                      <span className="users__role">{USER_ROLE_LABELS[u.role]}</span>
                    </td>
                    <td>
                      {confirmingId === u.id ? (
                        <span className="users__confirm" data-testid={`user-confirm-${u.id}`}>
                          <span className="users__confirm-label">Yakin?</span>
                          <button
                            type="button"
                            className="btn btn--ghost users__confirm-delete"
                            onClick={() => onDelete(u.id)}
                            data-testid={`user-confirm-delete-${u.id}`}
                          >
                            Hapus
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary"
                            onClick={() => setConfirmingId(null)}
                            data-testid={`user-confirm-cancel-${u.id}`}
                          >
                            Batal
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => setConfirmingId(u.id)}
                          disabled={isSelf}
                          title={isSelf ? 'Tidak dapat menghapus akun sendiri' : 'Hapus pengguna'}
                          data-testid={`user-delete-${u.id}`}
                        >
                          Hapus
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}