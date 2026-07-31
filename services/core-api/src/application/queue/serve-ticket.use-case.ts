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
 * Command for the "begin serving" operation (FR-CLR-03). Starts service on the
 * ticket currently being called at this counter.
 */
export interface ServeTicketCommand {
  readonly ticketId: TicketId;
}

/** Outcome of "serve": the ticket is SERVING. */
export type ServeTicketResult = {
  readonly status: 'serving';
  readonly ticket: TicketStateDto;
};

/**
 * Begins serving a called ticket — CALLING -> SERVING ("Mulai Melayani",
 * FR-CLR-03). Loads the ticket, drives the aggregate's `startServing` against
 * the active {@link ITransitionPolicy} (the same validator every queue action
 * uses, QUE-10 AC#3), persists it, and returns a transport-agnostic DTO.
 * Illegal transitions (e.g. serving a WAITING ticket) surface as an
 * {@link InvalidStateTransitionException} from the aggregate (AC#2).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here.
 */
export class ServeTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: ServeTicketCommand): Promise<ServeTicketResult> {
    // Resolve the active transition policy per execution (see CallNextTicketUseCase
    // for the rationale — the aggregate validates transitions synchronously, so
    // the use case resolves the sync policy here and passes it into the aggregate).
    const transitionPolicy = await this.policyResolver.getActivePolicy();
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.startServing(transitionPolicy, this.clock());
    await this.queue.save(ticket);
    // Drain the recorded TicketStatusChangedEvent so it broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'serving', ticket: projectTicketState(ticket) };
  }
}