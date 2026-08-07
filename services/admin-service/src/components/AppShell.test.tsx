import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell';

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

  it('renders the five enabled nav links (grouped, task-oriented IA)', () => {
    renderShell('/');
    expect(screen.getByRole('link', { name: 'Status Antrian' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Konfigurasi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analitik & Laporan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log Audit' })).toBeInTheDocument();
    // Pengguna resolves to the real /users surface (QUE-43 landed AuthN/AuthZ +
    // user management, absorbing the disabled placeholder this ticket originally
    // shipped). It is a normal enabled NavLink now — no disabled machinery.
    expect(screen.getByRole('link', { name: 'Pengguna' })).toHaveAttribute('href', '/users');
    // Group headings render as non-heading labels. The "Pengguna" group label
    // and its single item both read "Pengguna", so scope the group assertion to
    // the .nav-group__label element to disambiguate.
    expect(screen.getByText('Operasional')).toBeInTheDocument();
    expect(screen.getByText('Konfigurasi Sistem')).toBeInTheDocument();
    expect(screen.getByText('Pengguna', { selector: '.nav-group__label' })).toBeInTheDocument();
  });

  it('marks the active link with nav-link--active + aria-current', () => {
    renderShell('/');
    const dashboard = screen.getByRole('link', { name: 'Status Antrian' });
    expect(dashboard).toHaveClass('nav-link--active');
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    // The other links are not active.
    expect(screen.getByRole('link', { name: 'Konfigurasi' })).not.toHaveClass('nav-link--active');
    expect(screen.getByRole('link', { name: 'Analitik & Laporan' })).not.toHaveClass('nav-link--active');
  });

  it('marks the Konfigurasi link active on /config', () => {
    renderShell('/config');
    const config = screen.getByRole('link', { name: 'Konfigurasi' });
    expect(config).toHaveClass('nav-link--active');
    expect(config).toHaveAttribute('aria-current', 'page');
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
    // items cluster — otherwise the nav is a flat 5-link list with no grouping
    // (CLAUDE.md ARIA rule: a labelled cluster is role="group" + aria-label).
    const groups = screen.getAllByRole('group');
    const labels = groups.map((g) => g.getAttribute('aria-label'));
    expect(labels).toContain('Operasional');
    expect(labels).toContain('Analitik');
    expect(labels).toContain('Konfigurasi Sistem');
    expect(labels).toContain('Audit');
    expect(labels).toContain('Pengguna');
    // The group label elements themselves stay visual-only.
    document.querySelectorAll('.nav-group__label').forEach((el) => {
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