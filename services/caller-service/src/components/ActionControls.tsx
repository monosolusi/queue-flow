import { useId, useMemo } from 'react';
import type { ICallerApi } from '../api/caller-api';
import type { TicketStateDto, WorkflowActionsDto } from '../api/types';
import {
  actionRunKey,
  actionTestId,
  isRunnable,
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
 * transition's `actionLabel`. Every flow edge is a plain status change ("Ubah
 * Status"); the panel adds no workflow steps of its own.
 *
 * Four clusters, in order:
 *
 * 1. **Call next** — the counter-level entry action. It renders only when the
 *    flow actually has a `WAITING -> CALLING` edge it can honour (delete it in the
 *    designer and the button goes away), labelled with that edge's wording. It
 *    is disabled while an unresolved ticket occupies the counter: the store
 *    projects `active` to the tickets still at it (a completed one leaves, a
 *    skipped one moves to the skipped list), so `active !== null` means staff
 *    must resolve the current ticket first — calling next on top of it would
 *    strand it in CALLING forever and corrupt analytics.
 * 2. **Flow actions** — one button per outgoing edge of `active.status`, each a
 *    plain status change. An edge the panel cannot run (see `isRunnable`) is
 *    rendered disabled with the reason, never silently dropped: a configured
 *    transition that simply vanishes is exactly the complaint this derivation
 *    exists to fix.
 * 3. **Pindah Kategori** — a standalone category-move action (FR-CLR-03), NOT a
 *    flow edge. Offered on the active ticket only, and only while the bound
 *    counter serves at least one other category (a single-category counter would
 *    show a button that can never be tapped, so the cluster is hidden instead).
 *    It always lands the ticket back in WAITING with a new per-category number.
 * 4. **Utilities** — "Panggil Lagi", the built-in re-announce fallback. Kept
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
  // duplicating it under different wording. Recognised by the edge itself (a
  // runnable self-loop on CALLING): arriving in CALLING re-announces by design,
  // and the announcement is what that edge means.
  const flowOwnsReannounce = actions.some(
    (a) => a.from === 'CALLING' && a.to === 'CALLING' && isRunnable(a),
  );
  // Destination categories for the standalone transfer, derived once per active
  // ticket. Hidden entirely when the counter serves no other category — a
  // perpetually-disabled button reads as broken, and there is genuinely nowhere
  // to move.
  const transferCands = useMemo(
    () => (active ? transferCandidates(bound, active.categoryId) : []),
    [bound, active?.categoryId],
  );

  function fire(action: WorkflowAction): void {
    if (!active) return;
    void run(actionRunKey(active.ticketId, action), () =>
      invokeWorkflowAction(api, action, active.ticketId, { counterId: bound.counterId }),
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

            if (!isRunnable(action)) {
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

      {active && transferCands.length > 0 && (
        <div className="action-controls__transfer" role="group" aria-label="Pindah kategori">
          <TransferAction
            // `key` is ticket-scoped, so a different ticket taking the counter
            // remounts the chooser — i.e. collapses it.
            key={`transfer-${active.ticketId}`}
            actionLabel="Pindah Kategori"
            candidates={transferCands}
            busy={pending === 'transfer'}
            disabled={blockedApartFrom('transfer')}
            onTransfer={(categoryId) =>
              void run('transfer', () => api.transfer(active.ticketId, categoryId))
            }
            idPrefix="action-transfer"
          />
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