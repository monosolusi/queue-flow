import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CallHistory } from './CallHistory';
import type { NowServing } from '../state/tv-store';

const hist: NowServing[] = [
  { ticketId: 't1', ticketNumber: 'A-005', counterId: 2 },
  { ticketId: 't2', ticketNumber: 'B-001', counterId: 1 },
];

describe('CallHistory (AC9 h3, structural)', () => {
  afterEach(cleanup);

  it('populated: title is a level-3 heading + items are list items (AC9)', () => {
    render(<CallHistory history={hist} />);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('Riwayat Panggilan');
    expect(heading).toHaveClass('call-history__title');
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('A-005');
    expect(items[0]).toHaveTextContent('Counter 2');
    expect(items[1]).toHaveTextContent('B-001');
  });

  it('empty: title still a level-3 heading + empty hint', () => {
    render(<CallHistory history={[]} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Riwayat Panggilan');
    expect(screen.getByText('Belum ada riwayat.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});