import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaitingQueueList } from './WaitingQueueList';
import { ticketActionsFor } from '../lib/workflow-actions';
import type { TicketStateDto, WorkflowActionsDto } from '../api/types';
import { PRD_DEFAULT_WORKFLOW, edge, workflowActions } from '../test/workflow-fixtures';

const tickets: readonly TicketStateDto[] = [
  { ticketId: 'w1', ticketNumber: 'A-002', categoryId: 'cat-a', status: 'WAITING', counterId: null },
  { ticketId: 'w2', ticketNumber: 'A-003', categoryId: 'cat-a', status: 'WAITING', counterId: null },
];

/** A manager-configured flow that gives waiting tickets their own steps. */
const configured: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya'),
  edge('WAITING', 'SKIPPED', 'Lewati / Absen'),
  edge('WAITING', 'BATAL', 'Batalkan Tiket'),
);

describe('WaitingQueueList (FR-CLR-02 — waiting actions follow the flow)', () => {
  it('renders numbers only when the flow gives WAITING no per-ticket transitions', () => {
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(PRD_DEFAULT_WORKFLOW, 'WAITING')}
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
    expect(onAction.mock.calls[0][1]).toMatchObject({ to: 'BATAL' });
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
        notice="Tunggu perintah sebelumnya selesai."
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tunggu perintah sebelumnya selesai.')).toBeInTheDocument();
  });

  it('surfaces a failed waiting-list command inline', () => {
    render(
      <WaitingQueueList
        tickets={tickets}
        waitingCount={2}
        actions={ticketActionsFor(configured, 'WAITING')}
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
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('Tidak ada antrian menunggu.')).toBeInTheDocument();
  });
});