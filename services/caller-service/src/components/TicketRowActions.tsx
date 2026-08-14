import { useId } from 'react';
import type { TicketStateDto } from '../api/types';
import { actionRunKey, isRunnable, type WorkflowAction } from '../lib/workflow-actions';

export interface TicketRowActionsProps {
  readonly ticket: TicketStateDto;
  /** The runnable outgoing transitions of this row's status — already narrowed
   *  by {@link runnableRowActions}, so the list and its rows agree on whether
   *  there is anything to show. */
  readonly actions: readonly WorkflowAction[];
  /** Key of the command currently in flight for this list (see `actionRunKey`),
   *  or `null`. Every row of a list shares one runner, so a non-null value that
   *  is not this button's key means another row is busy. */
  readonly pending?: string | null;
  /** Test-id stem, e.g. `waiting-action` → `waiting-action-<ticketId>-<to>`. */
  readonly testIdStem: string;
  readonly onAction: (ticket: TicketStateDto, action: WorkflowAction) => void;
}

/**
 * The per-row cluster of flow actions shared by the queue lists (the waiting
 * list and the skipped list). One place decides how a transition becomes a
 * control — a plain button, or a disabled button with its reason — so the two
 * lists cannot drift apart; each list keeps only its own heading, empty state
 * and test-id stem.
 *
 * Row actions are status changes only. "Pindah Kategori" is a standalone action
 * on the active ticket, not a per-row flow edge, so it never appears here.
 *
 * Purely presentational: it neither fetches the flow nor decides which command
 * runs an action; the workspace resolves both and passes them in.
 */
export function TicketRowActions({
  ticket,
  actions,
  pending = null,
  testIdStem,
  onAction,
}: TicketRowActionsProps) {
  // Stem for the per-edge explanation ids (`aria-describedby` on the disabled
  // unroutable buttons). One per row, so two rows offering the same edge never
  // share an id.
  const noteId = useId();

  return (
    <div
      className="ticket-actions"
      role="group"
      aria-label={`Aksi untuk tiket ${ticket.ticketNumber}`}
    >
      {actions.map((action) => {
        const key = actionRunKey(ticket.ticketId, action);
        const busy = pending === key;
        // A command from this list is running elsewhere. Disabling the other
        // rows keeps the one-at-a-time rule visible: without it a tap here is
        // turned away by the runner's guard and the button reads as dead.
        const blocked = pending !== null && !busy;
        const testId = `${testIdStem}-${ticket.ticketId}-${action.to}`;

        if (!isRunnable(action)) {
          // Configured in the flow but would change nothing. Rendered disabled
          // with the reason rather than as a button that would reject on tap —
          // and the reason is VISIBLE text, mirroring `ActionControls`: a
          // `title` tooltip needs a hover the counter's touch screen cannot
          // produce, so the row read as a dead button with no explanation at all.
          const describedBy = `${noteId}-${action.to}`;
          return (
            <div key={key} className="ticket-actions__unroutable">
              <button
                type="button"
                className="btn btn--secondary ticket-actions__button ticket-actions__button--unavailable"
                data-testid={testId}
                disabled
                aria-describedby={describedBy}
              >
                {action.actionLabel} (tidak tersedia)
              </button>
              <p id={describedBy} className="ticket-actions__note">
                {action.unavailableReason}
              </p>
            </div>
          );
        }

        return (
          <button
            key={key}
            type="button"
            className="btn btn--secondary ticket-actions__button"
            data-testid={testId}
            onClick={() => onAction(ticket, action)}
            disabled={busy || blocked}
          >
            {busy ? '…' : action.actionLabel}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The subset of a status's transitions a queue list can actually render.
 * Without a handler there is nothing to run, so a list degrades to plain numbers.
 */
export function runnableRowActions(
  actions: readonly WorkflowAction[],
  hasHandler: boolean,
): readonly WorkflowAction[] {
  if (!hasHandler) return [];
  return actions;
}