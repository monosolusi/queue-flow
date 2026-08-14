import type {
  ITransitionPolicyResolver,
  StatusValue,
  TransitionDescriptor,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import { TransitionAction, type TransitionActionValue } from '../../domain/shared';

/**
 * Machine-readable reason a configured edge cannot be run from the counter panel.
 *
 * - `NO_STATUS_CHANGE` — a self-loop that would leave the ticket exactly where it
 *   is. `applyTransition` short-circuits when the target equals the current
 *   status, so the request would succeed, change nothing and broadcast nothing.
 *
 * A **code**, never user-facing copy: the backend owns the fact, the caller panel
 * owns the Indonesian wording.
 */
export type WorkflowActionUnavailableReason = 'NO_STATUS_CHANGE';

/**
 * One configured edge of the active state machine, as the counter panel needs it:
 * where it goes, what its button says, and what running it does.
 *
 * `action` is the manager's declaration, passed through verbatim — this
 * projection resolves nothing. There is no `command` field: which endpoint an
 * edge uses follows from `action` alone (a status change or a category move), so
 * there is nothing for the backend to rule on. It used to rule, keying on the
 * `(from, to)` pair, and the rule for WAITING read every `X -> WAITING` edge as a
 * category move — which is how a flow drawn to put a ticket back in the queue
 * produced a "Pindah Kategori" button asking for a destination category.
 */
export interface WorkflowActionDto {
  readonly from: StatusValue;
  readonly to: StatusValue;
  readonly actionLabel: string;
  /** What running this edge does — declared by the manager in the flow. */
  readonly action: TransitionActionValue;
  /** Why this edge cannot be run; `null` (the normal case) when it can. */
  readonly unavailableReason: WorkflowActionUnavailableReason | null;
}

/**
 * The full "what can I do from here?" projection, keyed by **source** status —
 * the shape the caller panel indexes by its active ticket's `currentStatus`.
 * Every state in the active schema is present; a state with no outgoing edge
 * maps to an empty array (a sink such as `COMPLETED`), so the client never has
 * to distinguish "unknown state" from "nothing to do".
 */
export interface WorkflowActionsDto {
  readonly byStatus: Record<string, readonly WorkflowActionDto[]>;
}

/**
 * Read-side use case: publishes the active state machine as the counter panel's
 * action surface (FR-CLR-02) — every configured edge, grouped by source status,
 * with the label and the action the manager gave it.
 *
 * It deliberately decides almost nothing. An earlier version resolved each
 * `(from, to)` pair to one of eight queue commands, and that table was the defect:
 * a pair does not carry enough information to say what the manager meant by the
 * edge, so the table guessed — reading `CALLING -> WAITING` as a category move
 * because the target happened to be WAITING. The flow now states its own
 * intent per edge, so this projection copies it out. What is left here is the one
 * fact the flow cannot state, because it follows from the aggregate rather than
 * the configuration: whether running an edge would actually do anything.
 *
 * Lives in the Queue context because that fact is Queue knowledge — and because
 * `application/store-config/**` -> `application/queue/**` is forbidden by
 * dep-cruiser, so it could not live on the Store-Config side without inverting
 * the dependency.
 *
 * Depends only on the domain {@link ITransitionPolicyResolver} port (DIP), and
 * resolves the active policy **per execution** — never a boot-time snapshot,
 * because the app boots before the first-run wizard writes a
 * `SystemConfiguration`. Pre-setup the resolver throws
 * `SystemNotConfiguredException` (→ 409), matching
 * `GET /api/system/state-machine`: the caller surfaces "not configured" rather
 * than rendering buttons for a graph it has no real config for.
 */
export class GetWorkflowActionsUseCase {
  constructor(private readonly policyResolver: ITransitionPolicyResolver) {}

  public async execute(): Promise<WorkflowActionsDto> {
    const policy = await this.policyResolver.getActivePolicy();
    const graph = policy.describeGraph();

    // Seed every schema state so a sink (COMPLETED) and an isolated state both
    // come back as `[]` rather than absent.
    const byStatus: Record<string, WorkflowActionDto[]> = {};
    for (const state of graph.states) {
      byStatus[state] = [];
    }
    for (const transition of graph.transitions) {
      // A well-formed policy only emits edges whose endpoints are in `states`
      // (the `StateMachine` constructor enforces it); the fallback keeps any
      // other conforming implementation from silently dropping an edge (LSP).
      (byStatus[transition.from] ??= []).push(describeAction(transition));
    }
    return { byStatus };
  }
}

function describeAction(transition: TransitionDescriptor): WorkflowActionDto {
  return {
    from: transition.from,
    to: transition.to,
    actionLabel: transition.actionLabel,
    action: transition.action,
    unavailableReason: unavailableReasonFor(transition),
  };
}

/**
 * Whether running this edge would visibly do anything — the only ruling left,
 * and a fact about the aggregate rather than about the manager's intent.
 *
 * A self-loop normally does nothing: `applyTransition` short-circuits when the
 * target equals the current status, so the button would return 200, change
 * nothing and broadcast nothing — which reads as a broken panel. Two self-loops
 * are exceptions and must be checked first:
 *
 * - a `TRANSFER_CATEGORY` edge moves the ticket to another category, which is a
 *   real change whether or not the status also moves (`transferTo` deliberately
 *   does not short-circuit);
 * - `CALLING -> CALLING` repeats the announcement, which is the entire point of
 *   drawing it — the customer did not hear the first one.
 */
function unavailableReasonFor(
  transition: TransitionDescriptor,
): WorkflowActionUnavailableReason | null {
  if (transition.action === TransitionAction.TRANSFER_CATEGORY) return null;
  if (transition.from !== transition.to) return null;
  if (transition.to === TicketStatus.CALLING) return null;
  return 'NO_STATUS_CHANGE';
}
