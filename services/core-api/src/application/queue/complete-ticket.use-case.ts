import type {
  IQueueRepository,
  ITransitionPolicy,
  TicketId,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for the "mark complete" operation (FR-CLR-03). Ends service on the
 * ticket currently being served at this counter.
 */
export interface CompleteTicketCommand {
  readonly ticketId: TicketId;
}

/** Outcome of "complete": the ticket is COMPLETED and leaves the active queue. */
export type CompleteTicketResult = {
  readonly status: 'completed';
  readonly ticket: TicketStateDto;
};

/**
 * Marks service complete — SERVING -> COMPLETED ("Selesai Layan", FR-CLR-03).
 * Loads the ticket, drives the aggregate's `complete` against the active
 * {@link ITransitionPolicy} (the same validator every queue action uses,
 * QUE-10 AC#3), persists it, and returns a transport-agnostic DTO. Illegal
 * transitions (e.g. completing a ticket that is not SERVING) surface as an
 * {@link InvalidStateTransitionException} from the aggregate (AC#2).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here.
 */
export class CompleteTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly transitionPolicy: ITransitionPolicy,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: CompleteTicketCommand): Promise<CompleteTicketResult> {
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.complete(this.transitionPolicy, this.clock());
    await this.queue.save(ticket);
    return { status: 'completed', ticket: projectTicketState(ticket) };
  }
}