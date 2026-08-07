import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth';

/**
 * Workspace user menu (QUE-43): shows the signed-in staff member's username
 * and a "Keluar" (Logout) action. Logout calls the idempotent server logout,
 * clears the bearer token (NOT the device-local counter binding — staff keep
 * their bound counter across re-login), and navigates to the public `/login`
 * route. The {@link RequireAuth} guard would also redirect once the user
 * nulls; the explicit navigate keeps the transition deterministic.
 *
 * Accessible dropdown: the toggle carries `aria-haspopup="menu"` +
 * `aria-expanded`, the popup is `role="menu"` with `role="menuitem"` entries,
 * and outside-click + Escape close it.
 */
export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  // Outside-click closes the menu.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Escape closes the menu and returns focus to the toggle.
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  if (!user) {
    return null;
  }

  async function handleLogout() {
    setOpen(false);
    navigate('/login');
    await logout();
  }

  const initial = (user.username.charAt(0) || 'S').toUpperCase();

  return (
    <div className="user-menu" ref={containerRef}>
      <button
        type="button"
        className="user-menu__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Akun, ${user.username}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-menu__chip" aria-hidden="true">
          {initial}
        </span>
        <span className="user-menu__user">{user.username}</span>
        <svg
          className="user-menu__chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          data-open={open}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={menuId} className="user-menu__popup" role="menu">
          <div className="user-menu__info" aria-hidden="true">
            <span className="user-menu__info-name">{user.username}</span>
            <span className="user-menu__info-role">{roleLabel(user.role)}</span>
          </div>
          <button
            type="button"
            className="user-menu__item user-menu__item--danger"
            role="menuitem"
            onClick={handleLogout}
          >
            <span className="user-menu__menuicon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M15 17l5-5-5-5" />
                <path d="M20 12H9" />
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              </svg>
            </span>
            Keluar
          </button>
        </div>
      )}
    </div>
  );
}

/** Friendly label for the auth role — never the raw `caller-staff` enum in UI copy. */
function roleLabel(role: string): string {
  return role === 'admin' ? 'Administrator' : 'Staff Loket';
}