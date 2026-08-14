import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TicketRowActions } from './TicketRowActions';
import { ticketActionsFor } from '../lib/workflow-actions';
import type { TicketStateDto } from '../api/types';
import { edge, workflowActions } from '../test/workflow-fixtures';

const ticket = (ticketId: string, ticketNumber: string): TicketStateDto => ({
  ticketId,
  ticketNumber,
  categoryId: 'cat-a',
  status: 'SKIPPED',
  counterId: 1,
});

/** A self-loop out of "Dilewati": configured in the designer, but it would leave
 *  the ticket exactly where it is — the edge the rows must explain rather than
 *  present as a dead button. */
const selfLoop = workflowActions(
  edge('SKIPPED', 'SKIPPED', 'Tandai Ulang', 'NO_STATUS_CHANGE'),
);

/**
 * A transition the counter panel cannot run used to carry its reason in a
 * `title` attribute only. The counter is a touch screen: there is no hover to
 * produce a tooltip, so staff saw a greyed-out button and no explanation at all.
 * The rows must be no less honest than {@link ActionControls}, which has always
 * rendered the reason as visible, described copy.
 */
describe('TicketRowActions explains an action it cannot run', () => {
  it('renders the reason as visible copy tied to its button, not as a tooltip', () => {
    render(
      <TicketRowActions
        ticket={ticket('s1', 'A-004')}
        actions={ticketActionsFor(selfLoop, 'SKIPPED')}
        testIdStem="skipped-action"
        onAction={vi.fn()}
      />,
    );
    const button = screen.getByTestId('skipped-action-s1-SKIPPED');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Tandai Ulang (tidak tersedia)');
    // Visible on the panel — which is what carries the meaning here: a disabled
    // button is not focusable, so the association below only pays off in a
    // screen reader's virtual cursor. Kept anyway, and kept identical to the
    // long-standing ActionControls pattern.
    expect(screen.getByText(/tidak mengubah status tiket/i)).toBeInTheDocument();
    // …tied to its own button rather than stranded beside it.
    const describedBy = button.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)).toHaveTextContent(
      /tidak mengubah status tiket/i,
    );
    // The tooltip-only regression this replaces.
    expect(button).not.toHaveAttribute('title');
  });

  it('gives each unrunnable edge of a row its own reason', () => {
    // Two edges, two different reasons: one shared note would explain the wrong
    // button for whichever came second.
    //
    // Both dead ends are ones core-api can really produce for a SKIPPED ticket.
    // The only reason code it sends is NO_STATUS_CHANGE (a self-loop), so the
    // second dead end is the forward-compatibility path instead: a reason code
    // newer than this build, which `unavailableCopy` degrades through the
    // unknown wording. A fixture for a wire shape the server never sends would
    // certify nothing.
    const twoDeadEnds = workflowActions(
      edge('SKIPPED', 'SKIPPED', 'Tandai Ulang', 'NO_STATUS_CHANGE'),
      edge('SKIPPED', 'ARSIP', 'Arsipkan', 'FUTURE_CODE' as never),
    );
    render(
      <TicketRowActions
        ticket={ticket('s1', 'A-004')}
        actions={ticketActionsFor(twoDeadEnds, 'SKIPPED')}
        testIdStem="skipped-action"
        onAction={vi.fn()}
      />,
    );
    const loop = screen.getByTestId('skipped-action-s1-SKIPPED');
    const unknown = screen.getByTestId('skipped-action-s1-ARSIP');
    expect(loop.getAttribute('aria-describedby')).not.toBe(
      unknown.getAttribute('aria-describedby'),
    );
    expect(document.getElementById(loop.getAttribute('aria-describedby')!)).toHaveTextContent(
      /tidak mengubah status tiket/i,
    );
    expect(document.getElementById(unknown.getAttribute('aria-describedby')!)).toHaveTextContent(
      /belum bisa dijalankan dari panel loket/i,
    );
  });

  it('keeps the note ids unique across rows offering the same edge', () => {
    // Every row of a list renders the same transitions; a note id derived from
    // the edge alone would repeat down the list and point assistive tech at the
    // first row's text for every ticket.
    const actions = ticketActionsFor(selfLoop, 'SKIPPED');
    render(
      <>
        <TicketRowActions
          ticket={ticket('s1', 'A-004')}
          actions={actions}
          testIdStem="skipped-action"
          onAction={vi.fn()}
        />
        <TicketRowActions
          ticket={ticket('s2', 'A-005')}
          actions={actions}
          testIdStem="skipped-action"
          onAction={vi.fn()}
        />
      </>,
    );
    const first = screen.getByTestId('skipped-action-s1-SKIPPED');
    const second = screen.getByTestId('skipped-action-s2-SKIPPED');
    expect(first.getAttribute('aria-describedby')).not.toBe(
      second.getAttribute('aria-describedby'),
    );
  });

  it('leaves a runnable action plain — the note belongs to the dead ends only', async () => {
    const onAction = vi.fn();
    const recall = workflowActions(edge('SKIPPED', 'CALLING', 'Panggil Ulang'));
    render(
      <TicketRowActions
        ticket={ticket('s1', 'A-004')}
        actions={ticketActionsFor(recall, 'SKIPPED')}
        testIdStem="skipped-action"
        onAction={onAction}
      />,
    );
    const button = screen.getByTestId('skipped-action-s1-CALLING');
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/panel loket/i)).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});