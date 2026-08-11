import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CountersServing } from './CountersServing';
import type { CounterServing } from '../api/types';

const serving: CounterServing[] = [
  { counterId: 1, counterName: 'Loket 1', ticketNumber: 'B-010', ticketId: 't2', status: 'SERVING', idle: false },
  { counterId: 2, counterName: 'Loket 2', ticketNumber: 'A-005', ticketId: 't1', status: 'CALLING', idle: false },
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

  it('idle counters render an em dash with the --idle modifier + aria-label', () => {
    const mixed: CounterServing[] = [
      { counterId: 1, counterName: 'Loket 1', ticketNumber: 'B-010', ticketId: 't2', status: 'SERVING', idle: false },
      { counterId: 2, counterName: 'Loket 2', ticketNumber: '—', ticketId: '', status: '', idle: true },
    ];
    render(<CountersServing countersServing={mixed} />);
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // The serving item does NOT carry the --idle modifier.
    expect(items[0]).not.toHaveClass('counters-serving__item--idle');
    // The idle item carries the --idle modifier; its number span shows the
    // em dash and carries role="img" + "belum melayani" aria-label (so AT
    // reliably reads the state instead of "em dash" — a bare <span> has the
    // ARIA `generic` role which prohibits name-from-author, so role="img" is
    // required to expose the aria-label). The counter name span stays
    // unchanged. The serving item's number span has neither role nor aria-label.
    expect(items[1]).toHaveClass('counters-serving__item--idle');
    const idleNumber = within(items[1]).getByText('—');
    expect(idleNumber).toHaveAttribute('role', 'img');
    expect(idleNumber).toHaveAttribute('aria-label', 'belum melayani');
    const servingNumber = within(items[0]).getByText('B-010');
    expect(servingNumber).not.toHaveAttribute('role');
    expect(servingNumber).not.toHaveAttribute('aria-label');
    expect(within(items[1]).getByText('Loket 2')).toBeInTheDocument();
  });
});
