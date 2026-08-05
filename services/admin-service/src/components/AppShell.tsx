import { useEffect, useId, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

/**
 * The persistent app shell (admin-service modernization): a fixed left
 * navigation + a top bar with a presentational profile area. The shell renders
 * the single `<main id="main-content">` landmark so the routed page owns the
 * h1 / page body (the shell owns the chrome). The first-run wizard keeps its
 * own full-width layout — when the route starts with `/wizard` the shell
 * renders the children inside `<main id="main-content">` but WITHOUT the
 * sidebar/topbar chrome, so the wizard's own `.wizard` container stays intact
 * AND the skip-link target + single-`<main>` landmark invariant (AC8) holds on
 * every route.
 *
 * `NavLink` gives `aria-current="page"` on the active link for free (a11y). The
 * page title in the topbar is a non-heading `<span>` (NOT an `<h2>`) — the
 * routed page owns the h1 (AC8), so the shell's chrome title must not be a
 * heading (an `<h2>` before the page `<h1>` is a heading-level inversion). It
 * is derived from the current pathname via a tiny pure lookup.
 */

/** Page title by pathname prefix (drives the topbar heading). */
function pageTitleFor(pathname: string): string {
  if (pathname === '/' || pathname === '') return 'Dashboard';
  if (pathname.startsWith('/config')) return 'Konfigurasi Operasional';
  if (pathname.startsWith('/analytics')) return 'Analitik Harian';
  return '';
}

/**
 * Presentational profile dropdown. No identity/auth layer exists (actor
 * `'admin'` is hardcoded per CLAUDE.md — the audit trail cannot distinguish
 * which manager performed a destructive op; out of scope until an auth layer
 * lands). This is a presentational profile area only — no login/logout, no
 * session menu. The two menu items route to real pages (`/config`,
 * `/wizard`).
 */
function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  // Close on outside click + Escape. The document listener is attached only
  // while open to avoid a permanent global listener (a tiny perf hygiene).
  useEffect(() => {
    if (!open) return;
    function onDocClick() {
      // The toggle button stops propagation, so any click that reaches the
      // document handler is an outside click.
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="profile">
      <button
        type="button"
        className="profile__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="profile__avatar" aria-hidden="true">
          M
        </span>
        <span className="profile__name">Manajer</span>
      </button>
      {open && (
        <div id={menuId} role="menu" className="profile__menu">
          <Link
            to="/config"
            role="menuitem"
            className="profile__menuitem"
            onClick={() => setOpen(false)}
          >
            Pengaturan
          </Link>
          <Link
            to="/wizard"
            role="menuitem"
            className="profile__menuitem"
            onClick={() => setOpen(false)}
          >
            Konfigurasi Awal (Wizard)
          </Link>
        </div>
      )}
    </div>
  );
}

export function AppShell({
  storeName,
  children,
}: {
  storeName?: string;
  children: React.ReactNode;
}) {
  const location = useLocation();
  // The wizard keeps its own full-width layout (no sidebar, no topbar — the
  // wizard page owns its chrome), but the skip-link target + single-<main>
  // landmark invariant (AC8) must hold on every route, so wrap the children in
  // the same <main id="main-content"> as the shell routes, just without chrome.
  if (location.pathname.startsWith('/wizard')) {
    return <main id="main-content">{children}</main>;
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    'nav-link' + (isActive ? ' nav-link--active' : '');

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">{storeName || 'QMS Admin'}</div>
        <nav aria-label="Navigasi utama">
          <NavLink to="/" end className={navLinkClass}>
            Dashboard
          </NavLink>
          <NavLink to="/config" className={navLinkClass}>
            Konfigurasi
          </NavLink>
          <NavLink to="/analytics" className={navLinkClass}>
            Analitik
          </NavLink>
        </nav>
      </aside>
      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <span className="app-shell__page-title" data-testid="app-shell-page-title">
            {pageTitleFor(location.pathname)}
          </span>
          <ProfileMenu />
        </header>
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}