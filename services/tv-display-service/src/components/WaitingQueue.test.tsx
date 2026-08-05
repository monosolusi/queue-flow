import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WaitingQueue } from './WaitingQueue';
import type { CategoryDto } from '../api/types';
import type { WaitingTicket } from '../state/tv-store';

const categories: CategoryDto[] = [
  { id: 'cat-a', code: 'A', name: 'Customer Service' },
  { id: 'cat-b', code: 'B', name: 'Kasir' },
];

const waiting: WaitingTicket[] = [
  { ticketId: 't1', ticketNumber: 'B-001', categoryId: 'cat-b' },
  { ticketId: 't2', ticketNumber: 'A-002', categoryId: 'cat-a' },
  { ticketId: 't3', ticketNumber: 'A-003', categoryId: 'cat-a' },
];

describe('WaitingQueue panel', () => {
  afterEach(cleanup);

  it('renders rows with 1-based position + bold ticket number + category name', () => {
    render(<WaitingQueue waiting={waiting} categories={categories} />);
    const list = screen.getByRole('list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    // Position + number + category name per row. The ticket number already
    // carries the category code as its prefix (e.g. B-001), so the row shows
    // the human-readable category name (e.g. "Kasir") instead of the code.
    expect(items[0]).toHaveTextContent('1.');
    expect(items[0]).toHaveTextContent('B-001');
    expect(items[0]).toHaveTextContent('Kasir');

    expect(items[1]).toHaveTextContent('2.');
    expect(items[1]).toHaveTextContent('A-002');
    expect(items[1]).toHaveTextContent('Customer Service');

    // Total count line reflects the full waiting list length.
    expect(screen.getByText(/Menunggu: 3 tiket/)).toBeInTheDocument();
  });

  it('caps the visible rows but still shows the full waitingCount', () => {
    const many: WaitingTicket[] = Array.from({ length: 15 }, (_, i) => ({
      ticketId: `t${i}`,
      ticketNumber: `A-${String(i + 1).padStart(3, '0')}`,
      categoryId: 'cat-a',
    }));
    render(<WaitingQueue waiting={many} categories={categories} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(10); // VISIBLE_LIMIT cap
    expect(screen.getByText(/Menunggu: 15 tiket/)).toBeInTheDocument();
  });

  it('renders the empty state when no tickets are waiting', () => {
    render(<WaitingQueue waiting={[]} categories={categories} />);
    expect(screen.getByText('Belum ada antrian menunggu.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByText(/Menunggu: 0 tiket/)).toBeInTheDocument();
  });

  it('is an aria-live polite region labelled "Antrian Berikutnya"', () => {
    render(<WaitingQueue waiting={waiting} categories={categories} />);
    const region = screen.getByLabelText('Antrian Berikutnya');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('waiting-queue');
  });
});