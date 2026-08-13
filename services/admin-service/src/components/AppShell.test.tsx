import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';
import { ToastProvider } from '../toast/toast-context';
import type { AuthState } from '../auth/useAuth';

/**
 * `useAuthContext` is stubbed so the logout tests can drive the ONE seam that
 * matters here: the `AuthState.logout` promise. The shipped `useAuth.logout`
 * deliberately swallows a failing `POST /api/auth/logout` ("best-effort — local
 * logout proceeds regardless"), so a rejecting `IAuthApi` would never reach the
 * shell; injecting a rejecting `AuthState` tests the shell's own contract with
 * the port (the abstraction) rather than the provider's internals.
 *
 * {@link DEFAULT_AUTH} is byte-identical to the real `AuthContext` default (null
 * user, no-op handlers), so every test that does not opt in behaves exactly as
 * it did when this file rendered the shell with no provider at all.
 *
 * The holder is a single module-level closure shared by every test in the file,
 * so a describe that mutates it MUST NOT leak into the next one (the CLAUDE.md
 * `vi.hoisted` accumulation trap). The file-scope `afterEach` below restores
 * the default unconditionally, so a describe appended later starts clean
 * whether or not it remembers to set up its own state.
 */
const authState = vi.hoisted(() => {
  const value: { current: AuthState } = {
    current: { user: null, loading: false, refresh: async () => {}, logout: async () => {} },
  };
  return value;
});

const DEFAULT_AUTH: AuthState = authState.current;

vi.mock('../auth/auth-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/auth-context')>()),
  useAuthContext: () => authState.current,
}));

afterEach(() => {
  authState.current = DEFAULT_AUTH;
});

/** The shell with the default (unauthenticated, no-op) auth state. */
function renderShell(path: string, storeName?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell storeName={storeName}>
        <div data-testid="child">child content</div>
      </AppShell>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  it('renders a single <main> landmark with id="main-content" on app routes', () => {
    renderShell('/', 'Apotek Sehat');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    // The child renders inside the main.
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders the brand label (storeName when provided, fallback otherwise)', () => {
    renderShell('/', 'Apotek Sehat');
    expect(screen.getByText('Apotek Sehat')).toBeInTheDocument();
  });

  it('falls back to "QMS Admin" when storeName is absent', () => {
    renderShell('/', undefined);
    expect(screen.getByText('QMS Admin')).toBeInTheDocument();
  });

  it('renders the two-level nav IA (big groups + Konfigurasi Sistem sub-groups)', () => {
    renderShell('/');
    // Flat-group leaves.
    expect(screen.getByRole('link', { name: 'Status Antrian' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analitik & Laporan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log Audit' })).toBeInTheDocument();
    // Pengguna resolves to the real /users surface (QUE-43 landed AuthN/AuthZ +
    // user management, absorbing the disabled placeholder this ticket originally
    // shipped). It is a normal enabled NavLink now — no disabled machinery.
    expect(screen.getByRole('link', { name: 'Pengguna' })).toHaveAttribute('href', '/users');
    // Konfigurasi Sistem is the only two-level group — its leaves live under
    // the Tampilan / Antrean / Sistem sub-groups (the in-content tablist was
    // consolidated into the sidebar; TV + Printer keep their own routes).
    expect(screen.getByRole('link', { name: 'Profil & Tampilan' })).toHaveAttribute('href', '/config/profil');
    expect(screen.getByRole('link', { name: 'Tampilan TV' })).toHaveAttribute('href', '/tv-layout');
    expect(screen.getByRole('link', { name: 'Kategori' })).toHaveAttribute('href', '/config/kategori');
    expect(screen.getByRole('link', { name: 'Counter & Routing' })).toHaveAttribute('href', '/config/counter-routing');
    expect(screen.getByRole('link', { name: 'Alur Status Tiket' })).toHaveAttribute('href', '/config/alur-status');
    expect(screen.getByRole('link', { name: 'Reset Harian' })).toHaveAttribute('href', '/config/reset-harian');
    expect(screen.getByRole('link', { name: 'Operasi Manual' })).toHaveAttribute('href', '/config/operasi-manual');
    expect(screen.getByRole('link', { name: 'Konfigurasi Printer' })).toHaveAttribute('href', '/printer-config');
    // Big-group headings render as non-heading labels.
    expect(screen.getByText('Operasional')).toBeInTheDocument();
    expect(screen.getByText('Konfigurasi Sistem')).toBeInTheDocument();
    expect(screen.getByText('Pengguna', { selector: '.nav-group__label' })).toBeInTheDocument();
    // Sub-group headings (Tampilan / Antrean / Sistem) render too.
    expect(screen.getByText('Tampilan', { selector: '.nav-subgroup__label' })).toBeInTheDocument();
    expect(screen.getByText('Antrean', { selector: '.nav-subgroup__label' })).toBeInTheDocument();
    expect(screen.getByText('Sistem', { selector: '.nav-subgroup__label' })).toBeInTheDocument();
  });

  it('marks the active link with nav-link--active + aria-current', () => {
    renderShell('/');
    const dashboard = screen.getByRole('link', { name: 'Status Antrian' });
    expect(dashboard).toHaveClass('nav-link--active');
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    // The other links are not active.
    expect(screen.getByRole('link', { name: 'Profil & Tampilan' })).not.toHaveClass('nav-link--active');
    expect(screen.getByRole('link', { name: 'Analitik & Laporan' })).not.toHaveClass('nav-link--active');
  });

  it('marks the Profil & Tampilan link active on /config/profil', () => {
    renderShell('/config/profil');
    const profil = screen.getByRole('link', { name: 'Profil & Tampilan' });
    expect(profil).toHaveClass('nav-link--active');
    expect(profil).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Status Antrian' })).not.toHaveClass('nav-link--active');
  });

  it('marks the Analitik & Laporan link active on /analytics', () => {
    renderShell('/analytics');
    const analytics = screen.getByRole('link', { name: 'Analitik & Laporan' });
    expect(analytics).toHaveClass('nav-link--active');
    expect(analytics).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Log Audit link active on /audit', () => {
    renderShell('/audit');
    const audit = screen.getByRole('link', { name: 'Log Audit' });
    expect(audit).toHaveClass('nav-link--active');
    expect(audit).toHaveAttribute('aria-current', 'page');
  });

  it('marks the Pengguna link active on /users (QUE-43 real user-management surface)', () => {
    renderShell('/users');
    const users = screen.getByRole('link', { name: 'Pengguna' });
    expect(users).toHaveClass('nav-link--active');
    expect(users).toHaveAttribute('aria-current', 'page');
    // No "segera hadir" hint — Pengguna is a real enabled link now, not a
    // disabled placeholder. The disabled-placeholder machinery was removed when
    // QUE-43 (AuthN/AuthZ + /users) merged first and absorbed this ticket's
    // planned placeholder (cross-branch overlap: defer to the canonical surface).
    expect(screen.queryByText('segera hadir')).not.toBeInTheDocument();
  });

  it('every nav icon is decorative (aria-hidden, no role/label)', () => {
    renderShell('/');
    // Assert via the .nav-icon container — every svg is decorative: the
    // adjacent nav label is the accessible name, so the icon carries no
    // role/aria-label of its own (deliberately different from chart SVGs).
    const svgs = document.querySelectorAll('.nav-icon svg');
    expect(svgs.length).toBeGreaterThan(0);
    svgs.forEach((svg) => {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).not.toHaveAttribute('role');
      expect(svg).not.toHaveAttribute('aria-label');
    });
  });

  it('exposes nav grouping semantics: each items cluster is role="group" + aria-label (M1)', () => {
    renderShell('/');
    // The visible group label is aria-hidden (a visual cue), so the grouping
    // structure for SR users must come from role="group" + aria-label on the
    // items cluster — otherwise the nav is a flat list with no grouping
    // (CLAUDE.md ARIA rule: a labelled cluster is role="group" + aria-label).
    // The two-level nav adds a role="group" + aria-label per sub-group too.
    const groups = screen.getAllByRole('group');
    const labels = groups.map((g) => g.getAttribute('aria-label'));
    expect(labels).toContain('Operasional');
    expect(labels).toContain('Analitik');
    expect(labels).toContain('Konfigurasi Sistem');
    expect(labels).toContain('Audit');
    expect(labels).toContain('Pengguna');
    // The Konfigurasi Sistem sub-groups carry their own role="group" + label.
    expect(labels).toContain('Tampilan');
    expect(labels).toContain('Antrean');
    expect(labels).toContain('Sistem');
    // The big-group + sub-group label elements themselves stay visual-only.
    document.querySelectorAll('.nav-group__label').forEach((el) => {
      expect(el).toHaveAttribute('aria-hidden', 'true');
    });
    document.querySelectorAll('.nav-subgroup__label').forEach((el) => {
      expect(el).toHaveAttribute('aria-hidden', 'true');
    });
  });

  it('derives the topbar page title from the pathname (non-heading span)', () => {
    // The topbar title is a non-heading <span> (NOT an <h2>) — the routed page
    // owns the h1, so the shell chrome must not introduce a heading (an <h2>
    // before the page <h1> is a heading-level inversion). Each render's unmount
    // is captured so the previous shell is removed before the next render
    // (otherwise two topbar titles coexist and getByTestId is ambiguous).
    let { unmount } = renderShell('/');
    const title = screen.getByTestId('app-shell-page-title');
    expect(title).toHaveTextContent('Status Antrian');
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    unmount();
    ({ unmount } = renderShell('/config'));
    expect(screen.getByTestId('app-shell-page-title')).toHaveTextContent('Konfigurasi Operasional');
    unmount();
    ({ unmount } = renderShell('/analytics'));
    expect(screen.getByTestId('app-shell-page-title')).toHaveTextContent('Analitik & Laporan');
    unmount();
    ({ unmount } = renderShell('/audit'));
    expect(screen.getByTestId('app-shell-page-title')).toHaveTextContent('Log Audit');
    unmount();
  });

  it('bypasses the shell chrome on /wizard routes but keeps the <main> landmark (AC8)', () => {
    renderShell('/wizard');
    // No sidebar/nav chrome on the wizard...
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // ...but the skip-link target + single-<main> landmark invariant holds.
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('bypasses the shell chrome on /login routes (QUE-43) but keeps the <main> landmark', () => {
    renderShell('/login');
    // No sidebar/nav chrome on the login page...
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    // ...but the skip-link target + single-<main> landmark invariant holds.
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('profile button has aria-haspopup=menu and toggles the menu on click', () => {
    renderShell('/');
    const toggle = screen.getByRole('button', { name: /Manajer/ });
    expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The menu renders two items — Pengaturan and the QUE-43 Keluar (sign-out)
    // action. The "Konfigurasi Awal (Wizard)" link was removed: the wizard is
    // first-run only now (gated by WizardGuard), and the store-name + state-
    // machine editing that used to live only in the wizard now lives in the
    // AdminPanel (no functionality lost).
    expect(screen.getByRole('menuitem', { name: 'Pengaturan' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Keluar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Konfigurasi Awal (Wizard)' })).not.toBeInTheDocument();
  });

  it('closes the profile menu on a second toggle click', () => {
    renderShell('/');
    const toggle = screen.getByRole('button', { name: /Manajer/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('closes the profile menu on an outside click', () => {
    renderShell('/');
    const toggle = screen.getByRole('button', { name: /Manajer/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // A click anywhere on the document body (outside the toggle + menu) closes.
    fireEvent.click(document.body);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the profile menu on Escape', () => {
    renderShell('/');
    const toggle = screen.getByRole('button', { name: /Manajer/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('AppShell — logout outcome handling', () => {
  // Derived from DEFAULT_AUTH so the two cannot drift; the file-scope afterEach
  // restores the default, so this never leaks into a later describe.
  beforeEach(() => {
    authState.current = {
      ...DEFAULT_AUTH,
      user: { id: 'u-1', username: 'manajer', role: 'admin' },
    };
  });

  /** The shell with a real ToastProvider so the two live regions exist. */
  function renderAuthedShell() {
    return render(
      <MemoryRouter initialEntries={['/']}>
        <ToastProvider>
          <AppShell storeName="Apotek Sehat">
            <div data-testid="child">child content</div>
          </AppShell>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  function openLogout() {
    fireEvent.click(screen.getByRole('button', { name: /manajer/i }));
    return screen.getByTestId('profile-logout');
  }

  it('a rejecting logout raises an error toast and releases the "Keluar…" button', async () => {
    // There was no `.catch()` at all before: a rejection left the item stuck on
    // "Keluar…" with aria-busy="true" AND surfaced as an unhandled rejection.
    authState.current = {
      ...authState.current,
      logout: vi.fn(() => Promise.reject(new Error('jaringan terputus'))),
    };
    renderAuthedShell();

    fireEvent.click(openLogout());

    expect(
      await within(screen.getByRole('alert')).findByText(/jaringan terputus/),
    ).toBeInTheDocument();
    const logoutItem = screen.getByTestId('profile-logout');
    await waitFor(() => expect(logoutItem).toHaveAttribute('aria-busy', 'false'));
    expect(logoutItem).toHaveTextContent('Keluar');
    expect(logoutItem).not.toHaveTextContent('Keluar…');
    expect(logoutItem).not.toBeDisabled();
  });

  it('a successful logout raises NO toast (landing on /login is the confirmation)', async () => {
    const logout = vi.fn(() => Promise.resolve());
    authState.current = { ...authState.current, logout };
    renderAuthedShell();

    fireEvent.click(openLogout());

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('alert')).toBeEmptyDOMElement();
  });

  it('two same-tick logout clicks call logout exactly once (synchronous ref guard)', async () => {
    const logout = vi.fn(() => Promise.resolve());
    authState.current = { ...authState.current, logout };
    renderAuthedShell();

    const logoutItem = openLogout();
    fireEvent.click(logoutItem);
    fireEvent.click(logoutItem);

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});
