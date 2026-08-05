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

  it('renders the three primary nav links', () => {
    renderShell('/');
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Konfigurasi' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analitik' })).toBeInTheDocument();
  });

  it('marks the active link with nav-link--active + aria-current', () => {
    renderShell('/');
    const dashboard = screen.getByRole('link', { name: 'Dashboard' });
    expect(dashboard).toHaveClass('nav-link--active');
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    // The other links are not active.
    expect(screen.getByRole('link', { name: 'Konfigurasi' })).not.toHaveClass('nav-link--active');
    expect(screen.getByRole('link', { name: 'Analitik' })).not.toHaveClass('nav-link--active');
  });

  it('marks the Konfigurasi link active on /config', () => {
    renderShell('/config');
    const config = screen.getByRole('link', { name: 'Konfigurasi' });
    expect(config).toHaveClass('nav-link--active');
    expect(config).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('nav-link--active');
  });

  it('marks the Analitik link active on /analytics', () => {
    renderShell('/analytics');
    const analytics = screen.getByRole('link', { name: 'Analitik' });
    expect(analytics).toHaveClass('nav-link--active');
    expect(analytics).toHaveAttribute('aria-current', 'page');
  });

  it('derives the topbar page title from the pathname (non-heading span)', () => {
    const { unmount } = renderShell('/');
    // The topbar title is a non-heading <span> (NOT an <h2>) — the routed page
    // owns the h1, so the shell chrome must not introduce a heading (an <h2>
    // before the page <h1> is a heading-level inversion).
    const title = screen.getByTestId('app-shell-page-title');
    expect(title).toHaveTextContent('Dashboard');
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    unmount();
    renderShell('/config');
    expect(screen.getByTestId('app-shell-page-title')).toHaveTextContent('Konfigurasi Operasional');
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

  it('profile button has aria-haspopup=menu and toggles the menu on click', () => {
    renderShell('/');
    const toggle = screen.getByRole('button', { name: /Manajer/ });
    expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The menu renders two items.
    expect(screen.getByRole('menuitem', { name: 'Pengaturan' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Konfigurasi Awal (Wizard)' })).toBeInTheDocument();
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