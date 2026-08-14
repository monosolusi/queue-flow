import type {
  IQueueRepository,
  ITransitionPolicyResolver,
  StatusValue,
  TicketId,
} from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { assertRunnableAsStatusChange } from './declared-transition-action';
import { QueueEventDispatcher } from './queue-event-dispatcher';
import { TicketStateDto, projectTicketState } from './ticket-state.dto';

/**
 * Command for running one configured transition of the active flow — the single
 * per-ticket state-change command (FR-CLR-02).
 */
export interface ApplyTransitionCommand {
  readonly ticketId: TicketId;
  /** The target status, canonical or custom (PREPARING, PAYMENT, …). The active
   *  {@link ITransitionPolicy} decides whether the edge is allowed. */
  readonly targetStatus: StatusValue;
  /**
   * The counter running the command — the caller panel's bound counter. Needed
   * only for a transition **into CALLING**, which has to announce the ticket
   * somewhere; the aggregate falls back to the counter the ticket already holds
   * (how a skipped ticket returns to the counter that called it) and rejects the
   * transition when neither is available. Every other target ignores it.
   */
  readonly counterId?: number | null;
}

/** Outcome of a transition: the ticket moved to `targetStatus`. */
export type ApplyTransitionResult = {
  readonly status: 'transitioned';
  readonly ticket: TicketStateDto;
};

/**
 * Runs one configured transition — `current -> targetStatus` — validated against
 * the active {@link ITransitionPolicy} (resolved per execution, the same resolver
 * every queue action uses, QUE-10 AC#3).
 *
 * This is **the** per-ticket state-change command. It accepts any target in the
 * active schema, canonical or custom, and the aggregate applies whatever side
 * effects that target state carries (announcement, service clock, re-queue).
 * There is deliberately no serve/complete/skip/recall command beside it: a
 * per-target command surface forces something upstream to decide which command a
 * given `(from, to)` pair needs, and that decision is precisely what cannot be
 * derived — it was the table that read every `X -> WAITING` edge as a category
 * move and handed a manager who drew `CALLING -> WAITING` a "Pindah Kategori"
 * button for a step they never configured.
 *
 * The one edge this command refuses is a `TRANSFER_CATEGORY` one, which needs a
 * destination category (see {@link assertRunnableAsStatusChange}). Illegal
 * transitions surface as {@link InvalidStateTransitionException} from the
 * aggregate (→ 409); a mis-routed one as `InvalidArgumentException` (→ 400).
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here. No `ITransactionManager` — a status
 * update reserves no sequence number, so there is nothing to make atomic with it
 * (NFR-REL-02); the transfer command, which does reserve one, has one. Not
 * audited — routine queue transitions are out of the NFR-SEC-02 audit scope
 * (manual reset / config / cleanup only).
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
    assertRunnableAsStatusChange(
      transitionPolicy.describeGraph(),
      ticket.currentStatus,
      command.targetStatus,
    );
    ticket.applyTransition(
      command.targetStatus,
      transitionPolicy,
      this.clock(),
      command.counterId ?? null,
    );
    await this.queue.save(ticket);
    // Drain the recorded events (STATUS_UPDATED, plus TICKET_CALLED when the
    // ticket landed in CALLING) so they broadcast (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);
    return { status: 'transitioned', ticket: projectTicketState(ticket) };
  }
}
