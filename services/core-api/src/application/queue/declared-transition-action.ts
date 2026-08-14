import type { StatusValue, TransitionGraph } from '../../domain/queue';
import { InvalidArgumentException, TransitionAction } from '../../domain/shared';
import type { TransitionActionValue } from '../../domain/shared';

/**
 * Reads what the manager declared a configured edge *does* — and refuses to run
 * an edge as anything else.
 *
 * Two of the three commands that move a ticket along an edge take the edge from
 * the client, and they are not interchangeable: a plain status change
 * (`ApplyTransitionUseCase`) and a category move (`TransferTicketUseCase`). Which
 * one an edge means is stated in the flow ({@link TransitionAction}), never
 * inferred from the edge's endpoints. Both therefore consult the same fact, so
 * the two guards live in one module — the mistake worth preventing is *drift*:
 * enforcing the pairing in only one direction would let the client pick the wrong
 * command for an edge and get a ticket that changed status without the category
 * move it was configured to make (or the reverse), with nothing failing.
 *
 * ## The third command, and the invariant it rests on
 *
 * `CallNextTicketUseCase` also moves a ticket along an edge and is deliberately
 * **not** guarded here, because it cannot reach a mis-declared one: it only ever
 * runs `WAITING -> CALLING`, and a `TRANSFER_CATEGORY` edge must target WAITING —
 * enforced when the configuration is saved (`SaveSystemConfigurationUseCase`,
 * because a re-issued per-category number describes a ticket nobody has served).
 * The two edge sets are disjoint, so a guard here would be unreachable code.
 *
 * **That invariant is load-bearing well beyond this module.** Four sites are safe
 * only because it holds: `call-next` (no guard at all), and — in the caller panel
 * — the counter-level `WAITING -> CALLING` presentation split, the
 * `CALLING -> CALLING` re-announce hand-off, and the skipped list's re-call
 * detection. Relaxing it (say, letting a category move land in SKIPPED so the
 * customer keeps their place) re-opens all four at once, and no test here would
 * fail. Anyone loosening the save rule has to revisit them together.
 *
 * A missing edge is deliberately **not** this module's error to raise: the
 * aggregate rejects an edge the flow does not contain with
 * `InvalidStateTransitionException` (→ 409), and pre-empting it here with a 400
 * would report a mis-drawn flow as a malformed request.
 */
export function declaredActionFor(
  graph: TransitionGraph,
  from: StatusValue,
  to: StatusValue,
): TransitionActionValue | undefined {
  return graph.transitions.find((t) => t.from === from && t.to === to)?.action;
}

/**
 * Guards the status-change command: the edge must not be a category move.
 * Running a `TRANSFER_CATEGORY` edge as a plain status change would advance the
 * ticket's status while silently skipping the category reassignment and the
 * re-issued number the manager configured — a half-executed action, and the
 * harder half missing.
 */
export function assertRunnableAsStatusChange(
  graph: TransitionGraph,
  from: StatusValue,
  to: StatusValue,
): void {
  if (declaredActionFor(graph, from, to) === TransitionAction.TRANSFER_CATEGORY) {
    throw new InvalidArgumentException(
      `transition '${from}' -> '${to}' is configured as a category transfer; ` +
        'it needs a destination category',
    );
  }
}

/**
 * Guards the transfer command: the edge must be declared a category move.
 * Without this, any edge at all could be used to move a ticket between
 * categories — the flow would no longer be the source of truth for what its own
 * buttons do.
 */
export function assertRunnableAsCategoryTransfer(
  graph: TransitionGraph,
  from: StatusValue,
  to: StatusValue,
): void {
  if (declaredActionFor(graph, from, to) !== TransitionAction.TRANSFER_CATEGORY) {
    throw new InvalidArgumentException(
      `transition '${from}' -> '${to}' is not configured as a category transfer`,
    );
  }
}
