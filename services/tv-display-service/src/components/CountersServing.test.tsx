import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CountersServing } from './CountersServing';
import type { CounterServing } from '../api/types';

const serving: CounterServing[] = [
  { counterId: 1, counterName: 'Loket 1', ticketNumber: 'B-010', ticketId: 't2', status: 'SERVING' },
  { counterId: 2, counterName: 'Loket 2', ticketNumber: 'A-005', ticketId: 't1', status: 'CALLING' },
];

describe('CountersServing (structural)', () => {
  afterEach(cleanup);

  it('populated: title is a level-3 heading + items are list items', () => {
    render(<CountersServing countersServing={serving} />);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('Sedang Melayani');
    expect(heading).toHaveClass('counters-serving__title');
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Loket 1');
    expect(items[0]).toHaveTextContent('B-010');
    expect(items[1]).toHaveTextContent('Loket 2');
    expect(items[1]).toHaveTextContent('A-005');
  });

  it('carries role="group" + aria-label on the section', () => {
    render(<CountersServing countersServing={serving} />);
    expect(screen.getByRole('group', { name: 'Counter Sedang Melayani' })).toBeInTheDocument();
  });

  it('empty: title still a level-3 heading + empty hint', () => {
    render(<CountersServing countersServing={[]} />);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Sedang Melayani');
    expect(screen.getByText('Tidak ada counter yang sedang melayani.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});