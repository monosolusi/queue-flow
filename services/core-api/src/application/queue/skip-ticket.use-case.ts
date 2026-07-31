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
 * Command for the "skip" / absent operation (FR-CLR-03). Marks the currently
 * called ticket as skipped so the counter can move on.
 */
export interface SkipTicketCommand {
  readonly ticketId: TicketId;
}

/** Outcome of "skip": the ticket is SKIPPED and can be recalled later. */
export type SkipTicketResult = {
  readonly status: 'skipped';
  readonly ticket: TicketStateDto;
};

/**
 * Skips / marks absent a calling ticket — CALLING -> SKIPPED ("Lewati / Absen",
 * FR-CLR-03). Loads the ticket, drives the aggregate's `skip` against the
 * active {@link ITransitionPolicy} (the same validator every queue action
 * uses, QUE-10 AC#3), persists it, and returns a transport-agnostic DTO.
 * Illegal transitions (e.g. skipping a ticket that is not CALLING) surface as
 * an {@link InvalidStateTransitionException} from the aggregate (AC#2).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here.
 */
export class SkipTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: SkipTicketCommand): Promise<SkipTicketResult> {
    const transitionPolicy = await this.policyResolver.getActivePolicy();
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }
    ticket.skip(transitionPolicy, this.clock());
    await this.queue.save(ticket);
    // Drain the recorded TicketStatusChangedEvent so it broadcasts (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'skipped', ticket: projectTicketState(ticket) };
  }
}