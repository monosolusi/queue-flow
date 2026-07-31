import type {
  IQueueRepository,
  ITransitionPolicy,
  ITransitionPolicyResolver,
  TicketId,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for the "recall" (Panggil Ulang) operation (FR-CLR-03). Re-announces a
 * previously skipped ticket.
 */
export interface RecallTicketCommand {
  readonly ticketId: TicketId;
}

/** Outcome of "recall": the ticket is back in CALLING. */
export type RecallTicketResult = {
  readonly status: 'recalled';
  readonly ticket: TicketStateDto;
};

/**
 * Re-calls a skipped ticket — SKIPPED -> CALLING ("Panggil Ulang", FR-CLR-03).
 * Loads the ticket, drives the aggregate's `recall` against the active
 * {@link ITransitionPolicy} (the same validator every queue action uses,
 * QUE-10 AC#3), persists it, and returns a transport-agnostic DTO. Illegal
 * transitions (e.g. recalling a ticket that is not SKIPPED) surface as an
 * {@link InvalidStateTransitionException} from the aggregate (AC#2).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here.
 */
export class RecallTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: RecallTicketCommand): Promise<RecallTicketResult> {
    const transitionPolicy = await this.policyResolver.getActivePolicy();
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.recall(transitionPolicy, this.clock());
    await this.queue.save(ticket);
    // Drain the recorded TicketStatusChangedEvent so it broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'recalled', ticket: projectTicketState(ticket) };
  }
}