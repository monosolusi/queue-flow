import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitingQueueList } from './WaitingQueueList';
import { ticketActionsFor } from '../lib/workflow-actions';
import type { TicketStateDto, WorkflowActionsDto } from '../api/types';
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
  { ticketId: 'w1', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
  { ticketId: 'w2', ticketNumber: 'A-003', categoryId: 'cat-a', status: 'WAITING', counterId: null },
];

/** A manager-configured flow that gives waiting tickets their own steps. */
const configured: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'UPDATE_STATUS'),
  edge('WAITING', 'SKIPPED', 'Lewati / Absen', 'UPDATE_STATUS'),
  edge('WAITING', 'BATAL', 'Batalkan Tiket', 'UPDATE_STATUS'),
);

describe('WaitingQueueList (FR-CLR-02 — waiting actions follow the flow)', () => {
  it('renders numbers only when the flow gives WAITING no per-ticket transitions', () => {
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'WAITING')}
        bound={bound}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('A-002')).toBeInTheDocument();
    // The PRD-default flow's only WAITING edge is → CALLING, which is the
    // counter-level call-next in the action panel, not a per-row button.
    expect(screen.queryByRole('group', { name: /Aksi untuk tiket/ })).not.toBeInTheDocument();
  });

  it("renders a button per WAITING outgoing transition on every row (the manager's example)", async () => {
    const onAction = vi.fn();
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(configured, 'WAITING')}
        bound={bound}
        onAction={onAction}
      />,
    );
    // Each row gets its own labelled cluster of immediate actions (role="group",
    // never role="option").
    const row = screen.getByRole('group', { name: 'Aksi untuk tiket A-002' });
    expect(row).toHaveTextContent('Lewati / Absen');
    expect(row).toHaveTextContent('Batalkan Tiket');
    // …and → CALLING is excluded (call-next is counter-level).
    expect(row).not.toHaveTextContent('Panggil Berikutnya');

    await userEvent.click(screen.getByTestId('waiting-action-w2-BATAL'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0][0]).toMatchObject({ ticketId: 'w2' });
    expect(onAction.mock.calls[0][1]).toMatchObject({ to: 'BATAL', action: 'UPDATE_STATUS' });
  });

  it('disables every row while a command is in flight, marking the one running', () => {
    // One runner serves the whole list, so a tap on another row while a command
    // is in flight is turned away by its guard. Disabling the rows says that
    // plainly — before the fix, the other buttons stayed live and a tap did
    // nothing at all: no pending state, no error, a dead button.
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(configured, 'WAITING')}
        bound={bound}
        pending="w1:WAITING->SKIPPED"
        onAction={vi.fn()}
      />,
    );
    const running = screen.getByTestId('waiting-action-w1-SKIPPED');
    const blocked = screen.getByTestId('waiting-action-w2-SKIPPED');
    expect(running).toBeDisabled();
    expect(blocked).toBeDisabled();
    // Only the in-flight one shows the busy label; the rest keep theirs.
    expect(running).toHaveTextContent('…');
    expect(blocked).toHaveTextContent('Lewati / Absen');
  });

  it('surfaces the wait hint when the runner turned a tap away', () => {
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(configured, 'WAITING')}
        bound={bound}
        notice="Tunggu perintah sebelumnya selesai."
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tunggu perintah sebelumnya selesai.')).toBeInTheDocument();
  });

  it('offers the category move with the destinations this counter serves', async () => {
    const onAction = vi.fn();
    const withTransfer = workflowActions(
      edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'UPDATE_STATUS'),
      edge('WAITING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'),
    );
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(withTransfer, 'WAITING')}
        bound={bound}
        onAction={onAction}
      />,
    );
    // One other category on this counter → a direct button, nothing to choose.
    await userEvent.click(screen.getByTestId('waiting-action-w1-WAITING'));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'w1' }),
      expect.objectContaining({ action: 'TRANSFER_CATEGORY' }),
      'cat-b',
    );
  });

  it('expands a chooser when the counter serves ≥2 other categories', async () => {
    const onAction = vi.fn();
    const threeCategories: BoundCounter = {
      ...bound,
      assignedCategoryIds: ['cat-a', 'cat-b', 'cat-c'],
      assignedCategories: [
        ...bound.assignedCategories,
        { id: 'cat-c', code: 'C', name: 'Informasi' },
      ],
    };
    const withTransfer = workflowActions(edge('WAITING', 'WAITING', 'Pindah Kategori', 'TRANSFER_CATEGORY'));
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(withTransfer, 'WAITING')}
        bound={threeCategories}
        onAction={onAction}
      />,
    );
    await userEvent.click(screen.getByTestId('waiting-action-w1-WAITING'));
    const chooser = await screen.findByTestId('waiting-action-w1-WAITING-chooser');
    expect(chooser).toHaveAttribute('role', 'group');
    expect(chooser).toHaveTextContent('Kasir');
    expect(chooser).toHaveTextContent('Informasi');
    // Each row owns its own chooser — opening w1's leaves w2 collapsed.
    expect(screen.queryByTestId('waiting-action-w2-WAITING-chooser')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('waiting-action-w1-WAITING-target-cat-c'));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 'w1' }),
      expect.objectContaining({ action: 'TRANSFER_CATEGORY' }),
      'cat-c',
    );
  });

  it('surfaces a failed waiting-list command inline', () => {
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(configured, 'WAITING')}
        bound={bound}
        error="transisi ilegal"
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('transisi ilegal')).toBeInTheDocument();
  });

  it('degrades to the plain list when no handler is wired (flow unavailable)', () => {
    render(<WaitingQueueList tickets={tickets} waitingCount={2} />);
    expect(screen.getByText('A-002')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Aksi untuk tiket/ })).not.toBeInTheDocument();
  });

  it('shows the empty state with no actions', () => {
    render(
      <WaitingQueueList
        tickets={[]}
        waitingCount={0}
        actions={ticketActionsFor(configured, 'WAITING')}
        bound={bound}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tidak ada antrian menunggu.')).toBeInTheDocument();
  });
});
