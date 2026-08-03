import type {
  IQueueRepository,
  ITransitionPolicyResolver,
  StatusValue,
  TicketId,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for the generic "apply transition" operation (QUE-33, FR-CLR-02).
 * Drives a wizard-configurable transition to an arbitrary target state — the
 * backing for every `action_label` that does not map to one of the six fixed
 * commands (call-next/serve/complete/skip/recall/transfer).
 */
export interface ApplyTransitionCommand {
  readonly ticketId: TicketId;
  /** The target status. May be a custom state (PREPARING, PAYMENT, …) — the
   *  active {@link ITransitionPolicy} decides whether the edge is allowed. */
  readonly targetStatus: StatusValue;
}

/** Outcome of a generic transition: the ticket moved to `targetStatus`. */
export type ApplyTransitionResult = {
  readonly status: 'transitioned';
  readonly ticket: TicketStateDto;
};

/**
 * Applies a generic, configurable transition — `current -> targetStatus` —
 * validated against the active {@link ITransitionPolicy} (resolved per
 * execution, the same resolver every queue action uses, QUE-10 AC#3). This is
 * a **plain status change**: it records a `STATUS_UPDATED` event but owns no
 * domain-specific side effects (no lifecycle timestamp, no counter/number
 * reassignment) — those belong to the fixed commands. The caller routes the
 * five known target states to those fixed endpoints; only custom targets
 * reach this use case, so the contract stays clean. Illegal transitions
 * surface as {@link InvalidStateTransitionException} from the aggregate (→ 409).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here. No `ITransactionManager` — a single
 * status update has no sequence reservation to guard (NFR-REL-02), matching
 * the skip/serve/complete/recall use cases. Not audited — routine queue
 * transitions are out of the NFR-SEC-02 audit scope (manual reset / config /
 * cleanup only), matching the six sibling commands.
 */
export class ApplyTransitionUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: ApplyTransitionCommand): Promise<ApplyTransitionResult> {
    const transitionPolicy = await this.policyResolver.getActivePolicy();
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.applyTransition(command.targetStatus, transitionPolicy, this.clock());
    await this.queue.save(ticket);
    // Drain the recorded TicketStatusChangedEvent so it broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'transitioned', ticket: projectTicketState(ticket) };
  }
}