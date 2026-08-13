import { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../auth/auth-context';
import { useToast } from '../toast/useToast';
import { NAV_GROUPS } from './nav-config';
import { ConfigIcon } from './nav-icons';

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
  if (pathname === '/' || pathname === '') return 'Status Antrian';
  if (pathname.startsWith('/config')) return 'Konfigurasi Operasional';
  if (pathname.startsWith('/tv-layout')) return 'Tampilan TV';
  if (pathname.startsWith('/printer-config')) return 'Konfigurasi Printer';
  if (pathname.startsWith('/analytics')) return 'Analitik & Laporan';
  if (pathname.startsWith('/users')) return 'Pengguna';
  if (pathname.startsWith('/audit')) return 'Log Audit';
  return '';
}

/**
 * Profile dropdown (QUE-43 identity layer). Shows the authenticated admin's
 * username from {@link useAuthContext} (falling back to "Manajer" when there is
 * no resolved user — e.g. the shell rendered without a provider in isolation
 * tests, or in the brief pre-`/me` window) and a "Keluar" item that calls the
 * context `logout` (best-effort `POST /api/auth/logout` + clear the local
 * session). Dropping the cached user to `null` makes {@link RequireAuth}
 * redirect to `/login` on the next render. Keeps the existing dropdown a11y
 * (aria-haspopup, role=menu, outside-click close, Escape close).
 *
 * The "Konfigurasi Awal (Wizard)" link was removed: the wizard is first-run
 * only now (gated by {@link WizardGuard}), and the store-name + state-machine
 * editing that used to live only in the wizard now lives in the operational
 * `AdminPanel` (no functionality lost). The menu carries "Pengaturan" (→
 * `/config`) + "Keluar".
 */
function ProfileMenu() {
  const { user, logout } = useAuthContext();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signingOutRef = useRef(false);
  const menuId = useId();

  const displayName = user?.username ?? 'Manajer';
  const avatar = displayName.charAt(0).toUpperCase() || 'M';

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
          {avatar}
        </span>
        <span className="profile__name" data-testid="profile-name">
          {displayName}
        </span>
        <svg
          className="profile__chevron"
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
        <div id={menuId} role="menu" className="profile__menu">
          <Link
            to="/config"
            role="menuitem"
            className="profile__menuitem"
            onClick={() => setOpen(false)}
          >
            <span className="profile__menuicon" aria-hidden="true">
              <ConfigIcon />
            </span>
            Pengaturan
          </Link>
          <button
            type="button"
            role="menuitem"
            className="profile__menuitem profile__menuitem--danger"
            disabled={signingOut}
            aria-busy={signingOut}
            data-testid="profile-logout"
            onClick={(e) => {
              e.stopPropagation();
              // The ref flips before the first await; `signingOut` only lands
              // after a re-render, so a state-only guard would let two same-tick
              // clicks both fire (CLAUDE.md touch-surface rule).
              if (signingOutRef.current) return;
              signingOutRef.current = true;
              setSigningOut(true);
              void logout()
                .then(() => {
                  setOpen(false);
                  // Dropping the cached user to null lets RequireAuth redirect
                  // to /login; an explicit navigation guarantees the redirect
                  // even on a route not gated by RequireAuth (defensive). No
                  // success toast — landing on /login IS the confirmation.
                  navigate('/login', { replace: true });
                })
                .catch((err) => {
                  // Previously there was no catch at all: a rejected logout left
                  // the item stuck on "Keluar…" forever AND raised an unhandled
                  // rejection. The manager stays signed in, so say so.
                  toast.error(
                    `Gagal keluar: ${err instanceof Error ? err.message : String(err)}`,
                  );
                })
                .finally(() => {
                  signingOutRef.current = false;
                  setSigningOut(false);
                });
            }}
          >
            <span className="profile__menuicon" aria-hidden="true">
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
            {signingOut ? 'Keluar…' : 'Keluar'}
          </button>
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
  // The wizard + login keep their own full-width layout (no sidebar, no topbar —
  // those pages own their chrome), but the skip-link target + single-<main>
  // landmark invariant (AC8) must hold on every route, so wrap the children in
  // the same <main id="main-content"> as the shell routes, just without chrome.
  if (location.pathname.startsWith('/wizard') || location.pathname.startsWith('/login')) {
    return <main id="main-content">{children}</main>;
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    'nav-link' + (isActive ? ' nav-link--active' : '');

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">{storeName || 'QMS Admin'}</div>
        <nav aria-label="Navigasi utama">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              {/* Non-heading label: an <h2>/<h3> here would invert the heading
                  order before the routed page's <h1> (AC8) — same rule the topbar
                  title follows. The visible label is a visual grouping cue only
                  (aria-hidden) — the grouping semantic for SR users is carried by
                  the role="group" + aria-label on the items cluster below (the
                  CLAUDE.md ARIA rule: a labelled cluster is role="group" +
                  aria-label, never a bare flat list). The subgroup follows the
                  SAME ARIA pattern: its label is a non-heading aria-hidden cue and
                  its items cluster is a role="group" + aria-label. */}
              <div className="nav-group__label" aria-hidden="true">
                {group.label}
              </div>
              <div className="nav-group__items" role="group" aria-label={group.label}>
                {group.subgroups
                  ? group.subgroups.map((sg) => (
                      <div className="nav-subgroup" key={sg.label}>
                        <div className="nav-subgroup__label" aria-hidden="true">
                          {sg.label}
                        </div>
                        <div className="nav-subgroup__items" role="group" aria-label={sg.label}>
                          {sg.items.map((item) => (
                            <NavLink key={item.label} to={item.to} end={item.end} className={navLinkClass}>
                              <span className="nav-icon" aria-hidden="true">
                                {item.icon}
                              </span>
                              <span>{item.label}</span>
                            </NavLink>
                          ))}
                        </div>
                      </div>
                    ))
                  : group.items?.map((item) => (
                      <NavLink key={item.label} to={item.to} end={item.end} className={navLinkClass}>
                        <span className="nav-icon" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span>{item.label}</span>
                      </NavLink>
                    ))}
              </div>
            </div>
          ))}
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