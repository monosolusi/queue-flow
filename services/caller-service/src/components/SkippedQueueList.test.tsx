import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkippedQueueList } from './SkippedQueueList';
import { ticketActionsFor } from '../lib/workflow-actions';
import type { TicketStateDto } from '../api/types';
import type { BoundCounter } from '../state/counter-binding';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';

const bound: BoundCounter = {
  counterId: 1,
  counterName: 'Loket 1',
  assignedCategoryIds: ['cat-a', 'cat-b'],
  assignedCategories: [
    { id: 'cat-a', code: 'A', name: 'Customer Service' },
    { id: 'cat-b', code: 'B', name: 'Kasir' },
  ],
};

const tickets: readonly TicketStateDto[] = [
  { ticketId: 's1', ticketNumber: 'A-004', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
  { ticketId: 's2', ticketNumber: 'A-005', categoryId: 'cat-a', status: 'SKIPPED', counterId: 1 },
];

describe('SkippedQueueList (FR-CLR-02 — a skipped ticket stays recallable)', () => {
  it('offers the flow\'s SKIPPED transitions on every row', async () => {
    const onAction = vi.fn();
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        bound={bound}
        onAction={onAction}
      />,
    );
    // Each row gets its own labelled cluster, like the waiting list.
    const row = screen.getByRole('group', { name: 'Aksi untuk tiket A-004' });
    expect(row).toHaveTextContent('Panggil Ulang');

    await userEvent.click(screen.getByTestId('skipped-action-s2-CALLING'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toMatchObject({ ticketId: 's2' });
    // No special case for recall: the command is the one the server named.
    expect(onAction.mock.calls[0][1]).toMatchObject({ to: 'CALLING', command: 'RECALL' });
  });

  it('renders whatever the flow says, not a hardcoded recall', async () => {
    const onAction = vi.fn();
    const configured = workflowActions(
      edge('SKIPPED', 'CALLING', 'Panggil Lagi Yang Absen', 'RECALL'),
      edge('SKIPPED', 'BATAL', 'Batalkan Tiket', 'APPLY_TRANSITION'),
    );
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(configured, 'SKIPPED')}
        bound={bound}
        onAction={onAction}
      />,
    );
    const row = screen.getByRole('group', { name: 'Aksi untuk tiket A-004' });
    expect(row).toHaveTextContent('Panggil Lagi Yang Absen');
    expect(row).toHaveTextContent('Batalkan Tiket');
    await userEvent.click(screen.getByTestId('skipped-action-s1-BATAL'));
    expect(onAction.mock.calls[0][1]).toMatchObject({ command: 'APPLY_TRANSITION' });
  });

  it('shows the empty state rather than disappearing', () => {
    render(
      <SkippedQueueList
        tickets={[]}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        bound={bound}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tidak ada tiket yang dilewati.')).toBeInTheDocument();
    expect(screen.getByText('0 tiket')).toBeInTheDocument();
  });

  it('disables every row while a command is in flight, marking the one running', () => {
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        bound={bound}
        pending="s1:SKIPPED->CALLING"
        onAction={vi.fn()}
      />,
    );
    const running = screen.getByTestId('skipped-action-s1-CALLING');
    const blocked = screen.getByTestId('skipped-action-s2-CALLING');
    expect(running).toBeDisabled();
    expect(running).toHaveTextContent('…');
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveTextContent('Panggil Ulang');
  });

  it('surfaces a failed command and the wait hint inline', () => {
    render(
      <SkippedQueueList
        tickets={tickets}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'SKIPPED')}
        bound={bound}
        error="transisi ilegal"
        notice="Tunggu perintah sebelumnya selesai."
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('transisi ilegal')).toBeInTheDocument();
    expect(screen.getByText('Tunggu perintah sebelumnya selesai.')).toBeInTheDocument();
  });

  it('degrades to the plain list when no handler is wired (flow unavailable)', () => {
    render(<SkippedQueueList tickets={tickets} />);
    expect(screen.getByText('A-004')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Aksi untuk tiket/ })).not.toBeInTheDocument();
  });
});
