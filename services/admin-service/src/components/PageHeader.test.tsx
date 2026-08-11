import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from './PageHeader';

describe('PageHeader (shared in-shell page header)', () => {
  it('renders the title as a heading level 1 (the page owns the <h1> — AC8)', () => {
    render(<PageHeader title="Status Antrian" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Status Antrian' });
    expect(heading).toBeInTheDocument();
    expect(heading.tagName).toBe('H1');
  });

  it('renders the subtitle as a <p> when provided', () => {
    render(<PageHeader title="Analitik & Laporan" subtitle="Ekspor laporan lokal (.xlsx)" />);
    const sub = screen.getByText('Ekspor laporan lokal (.xlsx)');
    expect(sub.tagName).toBe('P');
    expect(sub).toHaveClass('page-header__subtitle');
  });

  it('omits the subtitle when not provided', () => {
    render(<PageHeader title="Pengguna" />);
    // @testing-library's `screen` has no querySelector; query the document.
    expect(document.querySelector('.page-header__subtitle')).not.toBeInTheDocument();
  });

  it('renders the actions slot when provided', () => {
    render(
      <PageHeader
        title="Log Audit"
        subtitle="Riwayat tindakan sensitif"
        actions={
          <button type="button" data-testid="header-action">
            Refresh
          </button>
        }
      />,
    );
    expect(screen.getByTestId('header-action')).toBeInTheDocument();
  });

  it('omits the actions container when no actions are provided', () => {
    render(<PageHeader title="Pengguna" subtitle="Kelola akun." />);
    // @testing-library has no queryByClassName, so query the DOM directly.
    expect(document.querySelector('.page-header__actions')).not.toBeInTheDocument();
  });

  it('applies the --align-end modifier when actionsAlign="end"', () => {
    render(
      <PageHeader
        title="Analitik"
        actions={<input data-testid="picker" />}
        actionsAlign="end"
      />,
    );
    expect(document.querySelector('.page-header__actions')).toHaveClass('page-header__actions--align-end');
  });

  it('uses the default (center) alignment when actionsAlign is omitted', () => {
    render(<PageHeader title="Status" actions={<span data-testid="a">x</span>} />);
    const actions = document.querySelector('.page-header__actions');
    expect(actions).not.toHaveClass('page-header__actions--align-end');
  });
});