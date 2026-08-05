import type { IQueueRepository, TicketId } from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for the "reannounce" (Panggil Lagi) operation. Re-announces the
 * currently-calling ticket without a state change.
 */
export interface ReannounceTicketCommand {
  readonly ticketId: TicketId;
}

/** Outcome of "reannounce": the ticket is still CALLING (no state change). */
export type ReannounceTicketResult = {
  readonly status: 'reannounced';
  readonly ticket: TicketStateDto;
};

/**
 * Re-announces the currently-calling ticket — "Panggil Lagi". Loads the
 * ticket, drives the aggregate's `reannounce` (no state transition, so no
 * {@link ITransitionPolicyResolver} is consulted — distinct from `recall`,
 * which is a `SKIPPED -> CALLING` transition), persists it, drains the
 * re-emitted `TICKET_CALLED` event so it broadcasts (FR-ENG-04), and returns a
 * transport-agnostic DTO. The re-emit makes the TV board re-show the ticket
 * and the audio queue re-announce it (FR-TV-01/02) with no TV-side change —
 * the existing `TICKET_CALLED` projection handles it. Illegal states (a ticket
 * not in CALLING) surface as an {@link InvalidStateTransitionException} from
 * the aggregate (→ 409).
 *
 * Depends only on ports (DIP): no policy resolver, no transaction manager
 * (no sequence reservation is needed — the ticket number is unchanged), no
 * infrastructure concretions.
 */
export class ReannounceTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: ReannounceTicketCommand): Promise<ReannounceTicketResult> {
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.reannounce(this.clock());
    await this.queue.save(ticket);
    // Drain the re-emitted TICKET_CALLED so it broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'reannounced', ticket: projectTicketState(ticket) };
  }
}