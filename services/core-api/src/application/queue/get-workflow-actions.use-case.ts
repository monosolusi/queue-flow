import type {
  ITransitionPolicyResolver,
  StatusValue,
  TransitionDescriptor,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import { acceptsGenericTransitionTarget } from './generic-transition-target';

/**
 * The queue command that realizes a configured state-machine edge. One value per
 * command surface the caller panel can invoke:
 *
 * | command            | endpoint                                |
 * |--------------------|-----------------------------------------|
 * | `CALL_NEXT`        | `POST /api/queue/call-next`             |
 * | `RECALL`           | `POST /api/queue/:id/recall`            |
 * | `REANNOUNCE`       | `POST /api/queue/:id/reannounce`        |
 * | `SERVE`            | `POST /api/queue/:id/serve`             |
 * | `COMPLETE`         | `POST /api/queue/:id/complete`          |
 * | `SKIP`             | `POST /api/queue/:id/skip`              |
 * | `TRANSFER`         | `POST /api/queue/:id/transfer`          |
 * | `APPLY_TRANSITION` | `POST /api/queue/:id/transition`        |
 */
export type WorkflowCommand =
  | 'CALL_NEXT'
  | 'RECALL'
  | 'REANNOUNCE'
  | 'SERVE'
  | 'COMPLETE'
  | 'SKIP'
  | 'TRANSFER'
  | 'APPLY_TRANSITION';

/**
 * Machine-readable reason no command realizes a configured edge.
 *
 * - `NO_COMMAND` — the manager configured an edge no queue command can execute
 *   (e.g. `SERVING -> CALLING`: nothing moves an in-progress ticket back into
 *   CALLING).
 * - `NO_STATUS_CHANGE` — a self-loop that is not one of the two meaningful ones
 *   (`CALLING -> CALLING` re-announce / `WAITING -> WAITING` transfer). The
 *   aggregate's `transitionTo` short-circuits when `from === target`, so
 *   invoking a command for such an edge would 200 and do nothing.
 *
 * A **code**, never user-facing copy: the backend owns the fact, the caller
 * panel owns the Indonesian wording.
 */
export type WorkflowActionUnavailableReason = 'NO_COMMAND' | 'NO_STATUS_CHANGE';

/**
 * One configured edge of the active state machine plus the backend's ruling on
 * which command realizes it. `command` and `unavailableReason` are mutually
 * exclusive: exactly one of the two is non-null.
 */
export interface WorkflowActionDto {
  readonly from: StatusValue;
  readonly to: StatusValue;
  readonly actionLabel: string;
  /** The command that realizes this edge; `null` when none can. */
  readonly command: WorkflowCommand | null;
  /** Why `command` is null; `null` when `command` is non-null. */
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
 * Read-side use case: enumerates the active state machine and resolves, for
 * every configured edge, **which queue command executes it** (FR-CLR-02).
 *
 * This is the authority the caller panel used to duplicate client-side. Which
 * aggregate method / endpoint can realize a given `(from -> to)` pair, and what
 * its preconditions are, is Queue-context knowledge: it follows from the
 * `QueueTicket` aggregate's own guards (`recall` hard-requires SKIPPED,
 * `reannounce` hard-requires CALLING, `transitionTo` short-circuits on
 * `from === target`, `transferTo` deliberately does not), not from how the
 * manager drew the graph. The client renders labels and calls the command it is
 * told to; it no longer re-derives the routing.
 *
 * Lives in the Queue context (not Store Config) for exactly that reason — and
 * because `application/store-config/**` -> `application/queue/**` is forbidden
 * by dep-cruiser, so the ruling could not live on the Store-Config side without
 * inverting the dependency.
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

/** Pairs a configured edge with the command that realizes it. */
function describeAction(transition: TransitionDescriptor): WorkflowActionDto {
  return {
    from: transition.from,
    to: transition.to,
    actionLabel: transition.actionLabel,
    ...resolveCommand(transition.from, transition.to),
  };
}

type CommandResolution = Pick<WorkflowActionDto, 'command' | 'unavailableReason'>;

function realizedBy(command: WorkflowCommand): CommandResolution {
  return { command, unavailableReason: null };
}

function unavailable(reason: WorkflowActionUnavailableReason): CommandResolution {
  return { command: null, unavailableReason: reason };
}

/**
 * The resolution table. **Ordered** — the two meaningful self-loops must be
 * decided before the generic `from === to` rule, or a `CALLING -> CALLING`
 * re-announce and a `WAITING -> WAITING` transfer would both be mis-reported as
 * `NO_STATUS_CHANGE`.
 */
function resolveCommand(from: StatusValue, to: StatusValue): CommandResolution {
  // 1. Into CALLING — three distinct commands, keyed on where the ticket is now.
  //    `call-next` is counter-level (it picks the next ticket by routing +
  //    priority, not a specific one); `recall` hard-requires SKIPPED; a
  //    self-loop on CALLING is a re-announce (no status change, re-emits
  //    TICKET_CALLED). Nothing else can move a ticket back into CALLING.
  if (to === TicketStatus.CALLING) {
    if (from === TicketStatus.WAITING) return realizedBy('CALL_NEXT');
    if (from === TicketStatus.SKIPPED) return realizedBy('RECALL');
    if (from === TicketStatus.CALLING) return realizedBy('REANNOUNCE');
    return unavailable('NO_COMMAND');
  }
  // 2. Into WAITING — the category move ("pindah kategori"). Includes the
  //    `WAITING -> WAITING` self-loop: `transferTo` deliberately does NOT
  //    short-circuit on `from === to`, because a transfer is a category move
  //    whether or not the status also changes.
  if (to === TicketStatus.WAITING) return realizedBy('TRANSFER');
  // 3. Any other self-loop is a no-op: `transitionTo` returns early when
  //    `from === target`, so the command would 200 and change nothing.
  if (from === to) return unavailable('NO_STATUS_CHANGE');
  // 4. A custom (non-canonical) target — PREPARING, PAYMENT, … — is exactly
  //    what the generic transition endpoint exists for. This *predicts* that
  //    endpoint's admission rule, so it asks the rule itself
  //    ({@link acceptsGenericTransitionTarget}) rather than restating it: the
  //    controller enforces the same function, so the two can never drift.
  if (acceptsGenericTransitionTarget(to)) return realizedBy('APPLY_TRANSITION');
  // 5. The remaining canonical targets each have a dedicated command whose
  //    aggregate method owns the lifecycle-timestamp side effects.
  if (to === TicketStatus.SERVING) return realizedBy('SERVE');
  if (to === TicketStatus.COMPLETED) return realizedBy('COMPLETE');
  if (to === TicketStatus.SKIPPED) return realizedBy('SKIP');
  // Unreachable for today's five canonical states (every one is handled above).
  // Kept as a forward-compatibility guard: a canonical status added to
  // `TicketStatus` without a command mapping here reports "no command" instead
  // of routing the caller to an endpoint that would reject it.
  return unavailable('NO_COMMAND');
}
