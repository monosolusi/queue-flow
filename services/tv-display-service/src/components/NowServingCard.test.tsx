import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NowServingCard } from './NowServingCard';
import type { NowServing } from '../state/tv-store';

const t1: NowServing = { ticketId: 't1', ticketNumber: 'A-005', counterId: 2 };

describe('NowServingCard (AC1 aria-live, AC9 h2)', () => {
  afterEach(cleanup);

  it('announces the now-serving number via an assertive atomic live region (AC1)', () => {
    render(<NowServingCard nowServing={t1} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'assertive');
    expect(region).toHaveAttribute('aria-atomic', 'true');
  });

  it('exposes the label as a level-2 heading so the AT outline is h1→h2→h3 (AC9)', () => {
    render(<NowServingCard nowServing={t1} />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('SILAKAN KE LOKET');
    expect(heading).toHaveClass('now-serving__label');
  });

  it('renders the ticket number + counter id', () => {
    render(<NowServingCard nowServing={t1} />);
    expect(screen.getByText('A-005')).toBeInTheDocument();
    expect(screen.getByText('Loket 2')).toBeInTheDocument();
  });

  it('empty state: no live region (do not announce the idle message) + empty text (AC1)', () => {
    render(<NowServingCard nowServing={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/Menunggu panggilan berikutnya/)).toBeInTheDocument();
  });
});