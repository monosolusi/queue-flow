import { useEffect, useMemo, useRef, useState } from 'react';
import type { IUsersApi } from '../api/admin-api';
import type { UserDto, UserRole } from '../api/types';
import { useAuthContext } from '../auth/auth-context';
import { useToast } from '../toast/useToast';
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
 * Hand-rolled overlay modal for creating a new user. Mirrors the canonical
 * {@link RoutingEditModal} markup exactly (`.modal__overlay` → `.modal` with
 * `role="dialog"`/`aria-modal`/`aria-labelledby`, Escape + overlay-click close,
 * Batal discards the draft). NOT native `<dialog>` — jsdom does not implement
 * `showModal()`, so an overlay div pattern works identically in tests and real
 * browsers (NFR-MNT-01). A local draft (seeded from `emptyForm()`) lets Batal
 * discard; the caller drives mount/unmount via `showCreate`.
 *
 * A11y (WCAG 2.4.3): `returnFocusTo` was captured by the caller's `onClick`
 * (NOT here via `document.activeElement`, which by mount time has already
 * moved into the modal's `autoFocus` input); the modal restores focus to it on
 * unmount. Batal / Simpan / Escape / overlay-click all unmount the modal.
 */
function UserCreateModal({
  returnFocusTo,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
  onSubmit: (form: CreateForm) => Promise<void>;
  submitting: boolean;
  error: string | null;
}) {
  const [form, setForm] = useState<CreateForm>(emptyForm);

  // A11y (WCAG 2.4.3): return focus to the trigger (the "Tambah Pengguna"
  // button) when the modal unmounts. `returnFocusTo` was captured by the
  // caller's `onClick` (before `autoFocus` moves focus into the modal).
  useEffect(() => {
    return () => {
      returnFocusTo?.focus?.();
    };
  }, [returnFocusTo]);

  const createErrors = useMemo(() => validateCreate(form), [form]);
  const canSubmit = createErrors.length === 0 && !submitting;
  const titleId = 'users-create-title';

  return (
    <div
      className="modal__overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="user-create-modal"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h3 className="modal__title" id={titleId}>
          Tambah Pengguna
        </h3>

        <form
          className="users__form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!canSubmit) return;
            await onSubmit(form);
          }}
          noValidate
        >
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
              autoFocus
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
          {error && (
            <p className="users__error" role="alert" data-testid="users-create-error">
              {error}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="btn btn--secondary" onClick={onClose}>
              Batal
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!canSubmit}
              aria-busy={submitting}
              data-testid="create-submit"
            >
              {submitting ? 'Menambah…' : 'Tambah Pengguna'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Hand-rolled overlay modal confirming the deletion of one user. Mirrors the
 * canonical {@link RoutingEditModal} overlay pattern. Replaces the prior inline
 * two-step confirm (`confirmingId`) — the "Aksi" column now always renders a
 * single "Hapus" button so its width is stable (the column no longer shifts
 * when the manager presses "Hapus", which was the user-reported feedback).
 *
 * Same a11y pattern as {@link UserCreateModal}: `returnFocusTo` is captured at
 * the trigger's click time and focus is restored on unmount.
 */
function ConfirmDeleteUserModal({
  user,
  returnFocusTo,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  user: UserDto;
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  submitting: boolean;
  error: string | null;
}) {
  // A11y (WCAG 2.4.3): return focus to the trigger (the row's "Hapus" button)
  // when the modal unmounts. Captured by the caller's `onClick` before focus
  // moves into the modal.
  useEffect(() => {
    return () => {
      returnFocusTo?.focus?.();
    };
  }, [returnFocusTo]);

  const titleId = 'users-delete-title';
  const descId = 'users-delete-desc';

  return (
    <div
      className="modal__overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        data-testid={`user-confirm-${user.id}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h3 className="modal__title" id={titleId}>
          Hapus Pengguna
        </h3>
        <p id={descId}>
          Hapus pengguna &ldquo;{user.username}&rdquo;? Tindakan ini tidak dapat
          dibatalkan.
        </p>
        {error && (
          <p className="users__error" role="alert" data-testid="users-delete-error">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onClose}
            data-testid={`user-confirm-cancel-${user.id}`}
            autoFocus
          >
            Batal
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              void onConfirm();
            }}
            disabled={submitting}
            aria-busy={submitting}
            data-testid={`user-confirm-delete-${user.id}`}
          >
            {submitting ? 'Menghapus…' : 'Hapus'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The user-management page (QUE-43, `/users`). Admin-only: the route is wrapped
 * in {@link RequireAuth}, and the backend `GET /api/users` / `POST /api/users` /
 * `DELETE /api/users/:id` are admin-only (Bearer); a non-admin caller-staff who
 * reaches this page sees an access-denied notice (progressive enhancement — the
 * backend 403 is the authority). Lists every account with its friendly role
 * label. Adding and deleting users happen via overlay modals (mirrors the
 * counter-routing `RoutingEditModal` pattern) so the "Aksi" column width stays
 * stable — it always renders a single "Hapus" button (user feedback: the prior
 * inline two-step confirm widened the column and shifted the table on press).
 * Self-delete is blocked client-side (compare the current principal's id from
 * {@link useAuthContext}) — the backend's last-admin guard (400) is the safety
 * net for the admin role itself.
 */
export function UsersPage({ api }: { api: IUsersApi }) {
  const { user: me } = useAuthContext();
  const toast = useToast();
  const [users, setUsers] = useState<readonly UserDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Synchronous double-submit guards for the two mutations. `creating` /
  // `deleting` only take effect after a re-render, so a state-only check lets
  // two same-tick clicks through; these flip before the first `await`.
  const creatingRef = useRef(false);
  const deletingRef = useRef(false);

  // Create modal state. `createTrigger` captures the "Tambah Pengguna" button at
  // click time so the modal can return focus to it on close (a11y WCAG 2.4.3).
  const [showCreate, setShowCreate] = useState(false);
  const [createTrigger, setCreateTrigger] = useState<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Delete modal state. `deletingUser` replaces the prior inline `confirmingId`
  // — the table now always renders one "Hapus" button. `deleteTrigger` captures
  // the row's "Hapus" button at click time for focus restoration.
  const [deletingUser, setDeletingUser] = useState<UserDto | null>(null);
  const [deleteTrigger, setDeleteTrigger] = useState<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Stable focus host for the delete-success path — the toolbar "Tambah
  // Pengguna" button survives the list `reload()` (unlike the deleted row's
  // "Hapus" button), so focus is retained instead of falling to <body>.
  const addBtnRef = useRef<HTMLButtonElement | null>(null);

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

  /**
   * Creates the account, then announces the outcome.
   *
   * The success toast is the reported gap: the modal closes and the row appears,
   * but a manager who was looking at the button got no confirmation that the
   * account was actually created. The failure path deliberately stays INLINE in
   * the modal (`createError`) rather than becoming a toast — the modal stays
   * open on failure, so the message belongs next to the field the manager has
   * to correct, not in a corner of the screen.
   */
  async function onCreate(form: CreateForm) {
    // Synchronous double-submit guard — `creating` only lands after a
    // re-render, so two clicks in the same tick would both pass a state-based
    // check and create two accounts (CLAUDE.md touch-surface rule). The ref
    // flips before the first `await`; `creating` stays the visible affordance.
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      await api.createUser(form);
      setShowCreate(false);
      setCreateError(null);
      await reload();
      toast.success(`Pengguna "${form.username}" ditambahkan.`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  /** Deletes the account, announcing success; the refusal stays inline (the
   *  modal stays open so the manager reads why next to the Hapus they pressed). */
  async function onDelete(id: string) {
    // Same synchronous guard as `onCreate` — a double-tap must delete once.
    if (deletingRef.current) return;
    deletingRef.current = true;
    const username = users.find((u) => u.id === id)?.username ?? '';
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteUser(id);
      // A11y (WCAG 2.4.3): the modal's `returnFocusTo` (the row's "Hapus"
      // button) is detached by the `reload()` below — React 18 batches the
      // modal unmount + the table unmount (`loading=true`) into one commit, so
      // the cleanup's `returnFocusTo.focus()` is a no-op and focus would fall
      // to <body>. Focus a stable host that survives the reload (the toolbar
      // "Tambah Pengguna" button) BEFORE unmounting the modal. The modal
      // cleanup then no-ops on the detached row button and focus stays here.
      addBtnRef.current?.focus();
      setDeletingUser(null);
      setDeleteError(null);
      await reload();
      toast.success(`Pengguna "${username}" dihapus.`);
    } catch (err) {
      // The backend guards the last admin with 400; surface the message so the
      // manager sees why the delete was refused. The modal stays open.
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
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

      <section className="users__toolbar" data-testid="users-toolbar">
        <button
          ref={addBtnRef}
          type="button"
          className="btn btn--primary"
          onClick={(e) => {
            setCreateTrigger(e.currentTarget as HTMLElement);
            setShowCreate(true);
          }}
          data-testid="users-add-btn"
        >
          + Tambah Pengguna
        </button>
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
                <th scope="col" className="users__action">Aksi</th>
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
                    <td className="users__action">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={(e) => {
                          setDeleteTrigger(e.currentTarget as HTMLElement);
                          setDeletingUser(u);
                          setDeleteError(null);
                        }}
                        disabled={isSelf}
                        title={isSelf ? 'Tidak dapat menghapus akun sendiri' : 'Hapus pengguna'}
                        data-testid={`user-delete-${u.id}`}
                      >
                        Hapus
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {showCreate && (
        <UserCreateModal
          returnFocusTo={createTrigger}
          onClose={() => {
            setShowCreate(false);
            setCreateError(null);
          }}
          onSubmit={onCreate}
          submitting={creating}
          error={createError}
        />
      )}

      {deletingUser && (
        <ConfirmDeleteUserModal
          key={deletingUser.id}
          user={deletingUser}
          returnFocusTo={deleteTrigger}
          onClose={() => {
            setDeletingUser(null);
            setDeleteError(null);
          }}
          onConfirm={() => onDelete(deletingUser.id)}
          submitting={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}