import { useId, useMemo } from 'react';
import type { ICallerApi } from '../api/caller-api';
import type { TicketStateDto, WorkflowActionsDto } from '../api/types';
import {
  actionRunKey,
  actionTestId,
  callNextActionFor,
  ticketActionsFor,
  transferCandidates,
  type WorkflowAction,
} from '../lib/workflow-actions';
import { invokeWorkflowAction } from '../lib/workflow-commands';
import { useCommandRunner } from '../state/use-command-runner';
import type { BoundCounter } from '../state/counter-binding';
import { TransferAction } from './TransferAction';

export interface ActionControlsProps {
  readonly api: ICallerApi;
  readonly bound: BoundCounter;
  /** The active ticket (null when none). Its status selects the buttons. */
  readonly active: TicketStateDto | null;
  /** The action surface, owned by the workspace (`null` = not loaded / failed). */
  readonly workflow: WorkflowActionsDto | null;
  /** Hint shown when it could not be loaded (see `useWorkflowActions`). */
  readonly workflowError?: string | null;
}

/**
 * The counter panel's action buttons, derived entirely from the admin-designed
 * flow (FR-CLR-02 / QUE-20). The rule: **the buttons for a ticket are exactly
 * the outgoing transitions of its current status**, labelled with each
 * transition's `actionLabel`. The panel adds no workflow steps of its own.
 *
 * Three clusters, in order:
 *
 * 1. **Call next** — the counter-level entry action. It renders only when the
 *    flow actually has an edge out of WAITING that core-api resolved to
 *    `CALL_NEXT` (delete it in the designer and the button goes away), labelled
 *    with that edge's wording. It
 *    is disabled while an unresolved ticket occupies the counter: the store
 *    projects `active` to the tickets still at it (a completed one leaves, a
 *    skipped one moves to the skipped list), so `active !== null` means staff
 *    must resolve the current ticket first — calling next on top of it would
 *    strand it in CALLING forever and corrupt analytics.
 * 2. **Flow actions** — one button per outgoing edge of `active.status`, each
 *    carrying the command **core-api** resolved for it. An edge the counter
 *    panel cannot execute (`command === null`) is rendered disabled with the
 *    reason, never silently dropped: a configured transition that simply
 *    vanishes is exactly the complaint this derivation exists to fix.
 * 3. **Utilities** — "Panggil Lagi", the built-in re-announce fallback. Kept
 *    only while the flow says nothing about it: a re-announce IS a
 *    `CALLING → CALLING` self-loop (it repeats the call without changing the
 *    status, and the endpoint hard-requires CALLING), so a manager who draws
 *    that edge gets it as a flow action with their own wording and the built-in
 *    button steps aside — never both. The PRD §7 default flow has no such edge,
 *    so every existing install keeps the button. Being no transition at all in
 *    that case, it sits in its own labelled group, leaving the flow cluster a
 *    faithful picture of the graph.
 */
export function ActionControls({
  api,
  bound,
  active,
  workflow,
  workflowError,
}: ActionControlsProps) {
  const { pending, error, notice, run } = useCommandRunner();
  // Stem for the per-edge explanation ids (`aria-describedby` on the disabled
  // unroutable buttons).
  const noteId = useId();
  // One runner serves every button in the panel, so while one command is in
  // flight the others cannot start. Say that with `disabled` instead of letting
  // the runner's guard turn the tap away in silence.
  const blockedApartFrom = (key: string) => pending !== null && pending !== key;

  const callNext = useMemo(() => callNextActionFor(workflow), [workflow]);
  const actions = useMemo(
    () => ticketActionsFor(workflow, active?.status),
    [workflow, active?.status],
  );
  // The manager drew the `CALLING → CALLING` self-loop, so re-announce is part
  // of the flow now — the built-in utility button stands down rather than
  // duplicating it under different wording.
  const flowOwnsReannounce = actions.some((a) => a.command === 'REANNOUNCE');

  function fire(action: WorkflowAction, targetCategoryId?: string): void {
    if (!active) return;
    void run(actionRunKey(active.ticketId, action), () =>
      invokeWorkflowAction(api, action, active.ticketId, targetCategoryId),
    );
  }

  return (
    <section className="action-controls" aria-label="Aksi">
      {callNext && (
        <button
          type="button"
          className="btn btn--primary action-controls__call-next"
          onClick={() => void run('call-next', () => api.callNext(bound.counterId))}
          disabled={pending === 'call-next' || blockedApartFrom('call-next') || active !== null}
          title={
            active !== null
              ? 'Selesaikan tiket aktif terlebih dahulu (layani, lewati, atau selesaikan)'
              : undefined
          }
        >
          {pending === 'call-next' ? 'Memanggil…' : callNext.actionLabel}
        </button>
      )}

      {active && actions.length > 0 && (
        <div className="action-controls__flow" role="group" aria-label="Aksi sesuai alur status">
          {actions.map((action) => {
            const key = actionRunKey(active.ticketId, action);
            const busy = pending === key;
            const blocked = blockedApartFrom(key);
            const testId = actionTestId(action);

            if (action.command === null) {
              // Configured in the flow but unexecutable here. Shown disabled with
              // a visible reason so the manager can see the edge exists and why
              // the counter cannot run it.
              const describedBy = `${noteId}-${action.to}`;
              return (
                <div key={key} className="action-controls__unroutable">
                  <button
                    type="button"
                    className="btn btn--secondary action-controls__edge action-controls__unsupported"
                    data-testid={testId}
                    disabled
                    aria-describedby={describedBy}
                  >
                    {action.actionLabel} (tidak tersedia)
                  </button>
                  <p id={describedBy} className="action-controls__unroutable-note">
                    {action.unavailableReason}
                  </p>
                </div>
              );
            }

            if (action.command === 'TRANSFER') {
              return (
                <TransferAction
                  // `key` is ticket-scoped, so a different ticket taking the
                  // counter remounts the chooser — i.e. collapses it.
                  key={key}
                  action={action}
                  candidates={transferCandidates(bound, active.categoryId)}
                  busy={busy}
                  disabled={blocked}
                  onTransfer={(categoryId) => fire(action, categoryId)}
                  idPrefix={testId}
                />
              );
            }

            return (
              <button
                key={key}
                type="button"
                className="btn btn--secondary action-controls__edge"
                data-testid={testId}
                onClick={() => fire(action)}
                disabled={busy || blocked}
              >
                {busy ? '…' : action.actionLabel}
              </button>
            );
          })}
        </div>
      )}

      {active?.status === 'CALLING' && !flowOwnsReannounce && (
        <div
          className="action-controls__utilities"
          role="group"
          aria-label="Aksi tambahan (tidak mengubah status)"
        >
          <button
            type="button"
            className="btn btn--ghost action-controls__reannounce"
            data-testid="action-reannounce"
            onClick={() => void run('reannounce', () => api.reannounce(active.ticketId))}
            disabled={pending === 'reannounce' || blockedApartFrom('reannounce')}
            title="Mengulang panggilan di TV dan suara. Status tiket tidak berubah."
          >
            {pending === 'reannounce' ? 'Memanggil…' : 'Panggil Lagi'}
          </button>
        </div>
      )}

      {workflowError && (
        <p className="action-controls__error" data-testid="action-flow-error">
          {workflowError}
        </p>
      )}
      {notice && <p className="action-controls__notice">{notice}</p>}
      {error && <p className="action-controls__error">{error}</p>}
    </section>
  );
}
