import type {
  IQueueRepository,
  ITransitionPolicy,
  TicketId,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
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
    private readonly transitionPolicy: ITransitionPolicy,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: ServeTicketCommand): Promise<ServeTicketResult> {
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.startServing(this.transitionPolicy, this.clock());
    await this.queue.save(ticket);
    return { status: 'serving', ticket: projectTicketState(ticket) };
  }
}