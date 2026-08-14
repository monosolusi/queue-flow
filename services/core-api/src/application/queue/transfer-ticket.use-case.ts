import type {
  ICategoryRepository,
  IQueueRepository,
  ISequenceRepository,
  ITransitionPolicy,
  ITransitionPolicyResolver,
  TicketId,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import {
  EntityNotFoundException,
  InvalidArgumentException,
  InvalidStateTransitionException,
  ITransactionManager,
  NoOpTransactionManager,
} from '../../domain/shared';
import { assertRunnableAsCategoryTransfer } from './declared-transition-action';
import { QueueEventDispatcher } from './queue-event-dispatcher';

/**
 * Command for the "transfer queue" / "pindah kategori" operation (FR-CLR-03).
 * Moves a ticket to a different category, re-issuing its per-category number
 * and returning it to the queue under the new category.
 *
 * `dateKey` is the per-day sequence key (the same key ticket creation uses);
 * it is supplied explicitly so this use case does not own the date convention.
 * There is no `targetStatus`: a transferred ticket always lands in WAITING, which
 * is what a re-issued per-category number means (see `QueueTicket.transferTo`).
 */
export interface TransferTicketCommand {
  readonly ticketId: TicketId;
  readonly targetCategoryId: string;
  readonly dateKey: string;
}

/**
 * Projection of the transferred ticket. Carries both the new state (under the
 * target category) and the previous category/number so the caller UI can show
 * "A-001 moved to B-001" rather than just the new identity.
 */
export interface TransferredTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
  /** Always `null` after a transfer — the ticket re-enters the queue unassigned. */
  readonly counterId: number | null;
  readonly previousCategoryId: string;
  readonly previousTicketNumber: string;
}

/** Outcome of "transfer": the ticket is re-queued under the new category. */
export type TransferTicketResult = {
  readonly status: 'transferred';
  readonly ticket: TransferredTicketDto;
};

/**
 * Transfers a ticket to a different category — "pindah kategori" (FR-CLR-03).
 *
 * Transfer is a **first-class configurable transition**: the status leg
 * (current -> WAITING) is validated against the active {@link ITransitionPolicy} —
 * the same validator every queue action uses (QUE-10 AC#3). An active state
 * machine without the edge rejects the transfer with an
 * {@link InvalidStateTransitionException} (AC#2).
 *
 * The manager enables transfer by drawing the edge **and declaring its action
 * `TRANSFER_CATEGORY`**. Both halves are required, and the second is the reason
 * this command exists separately: a category move needs a destination the flow
 * cannot supply (staff pick it per ticket), so it has to be declared rather than
 * recognised. It used to be recognised — from the target state alone — which made
 * every `X -> WAITING` edge a category move and turned a plain "back to the
 * queue" step into a button demanding a category the counter may not even serve.
 *
 * The transition is pre-checked **before** reserving a new sequence number so
 * an illegal transfer does not burn or gap a per-category ticket number
 * (NFR-REL-02). On success a new number is issued via
 * {@link ISequenceRepository}, the aggregate's `transferTo` re-validates and
 * applies the reassignment, and the ticket is persisted.
 *
 * The sequence reservation + aggregate mutation + persist run inside one
 * {@link ITransactionManager.runInTransaction} so a durable implementation
 * commits the new per-category number and the ticket update atomically
 * (NFR-REL-02 — a power cut between the reserve and the save must not leave a
 * gap). The realtime broadcast is drained *after* the commit so a rolled-back
 * transfer is never announced. This mirrors `CreateTicketUseCase` /
 * `CallNextTicketUseCase`; the `txManager` defaults to a no-op so unit specs
 * that construct the use case directly stay unbroken.
 *
 * Depends only on ports (DIP): the active `StateMachine` is supplied by the
 * interface-adapter layer, not loaded here.
 */
export class TransferTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly categories: ICategoryRepository,
    private readonly sequences: ISequenceRepository,
    private readonly policyResolver: ITransitionPolicyResolver,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: TransferTicketCommand): Promise<TransferTicketResult> {
    // Resolve the active transition policy per execution (see CallNextTicketUseCase
    // for the rationale — the aggregate validates transitions synchronously).
    const transitionPolicy = await this.policyResolver.getActivePolicy();

    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }

    // Pre-check before reserving a sequence number so an illegal transfer
    // does not advance (and thus gap) the per-category sequence (NFR-REL-02).
    if (!transitionPolicy.isAllowed(ticket.currentStatus, TicketStatus.WAITING)) {
      throw new InvalidStateTransitionException(ticket.currentStatus, TicketStatus.WAITING);
    }
    // The edge must be the one the manager declared a category move. Checked
    // after `isAllowed` so a flow that lacks the edge entirely reports the
    // missing edge (409) rather than a mis-declared one (400) — and still before
    // any sequence is reserved.
    assertRunnableAsCategoryTransfer(
      transitionPolicy.describeGraph(),
      ticket.currentStatus,
      TicketStatus.WAITING,
    );

    const category = await this.categories.getById(command.targetCategoryId);
    if (!category) {
      throw new EntityNotFoundException('Category', command.targetCategoryId);
    }

    // "Pindah kategori" semantically moves a ticket to a *different* category.
    // A transfer to the ticket's own current category is a well-formed but
    // business-illegal argument: it would reserve a fresh per-category number
    // and re-issue the ticket under the same category — burning a sequence
    // slot for a no-op move and emitting a TICKET_TRANSFERRED with
    // fromCategoryId === toCategoryId. Reject it before any sequence is
    // reserved (NFR-REL-02 — an illegal transfer burns no number).
    if (command.targetCategoryId === ticket.categoryId) {
      throw new InvalidArgumentException(
        'Transfer target category must differ from the ticket current category',
      );
    }

    const previousCategoryId = ticket.categoryId;
    const previousTicketNumber = ticket.ticketNumber.formatted();

    // Reserve the new per-category number + apply the transfer + persist inside
    // one transaction so a durable implementation commits the sequence
    // reservation and the ticket update atomically (NFR-REL-02 — a power cut
    // between the reserve and the save must not gap the target category). The
    // realtime broadcast is drained *after* the commit so a rolled-back
    // transfer is never announced.
    const transferred = await this.txManager.runInTransaction(async () => {
      const newTicketNumber = await this.sequences.nextTicketNumber(
        command.targetCategoryId,
        category.code,
        command.dateKey,
      );
      ticket.transferTo(
        command.targetCategoryId,
        newTicketNumber,
        transitionPolicy,
        this.clock(),
      );
      await this.queue.save(ticket);
      return ticket;
    });

    // Drain the recorded TicketTransferredEvent + TicketStatusChangedEvent so
    // they broadcast (FR-ENG-04).
    await this.dispatcher.dispatch(transferred);

    return {
      status: 'transferred',
      ticket: {
        ticketId: ticket.id.value,
        ticketNumber: ticket.ticketNumber.formatted(),
        categoryId: ticket.categoryId,
        status: ticket.currentStatus,
        counterId: ticket.counterId,
        previousCategoryId,
        previousTicketNumber,
      },
    };
  }
}