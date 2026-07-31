import type {
  ICategoryRepository,
  IQueueRepository,
  ISequenceRepository,
  ITransitionPolicy,
  ITransitionPolicyResolver,
  StatusValue,
  TicketId,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import {
  EntityNotFoundException,
  InvalidStateTransitionException,
} from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';

/**
 * Command for the "transfer queue" / "pindah kategori" operation (FR-CLR-03).
 * Moves a ticket to a different category, re-issuing its per-category number
 * and returning it to the queue under the new category.
 *
 * `dateKey` is the per-day sequence key (the same key ticket creation uses);
 * it is supplied explicitly so this use case does not own the date convention.
 * `targetStatus` defaults to `WAITING` (re-queue) and is validated against the
 * active state machine — a transfer is a first-class configurable transition.
 */
export interface TransferTicketCommand {
  readonly ticketId: TicketId;
  readonly targetCategoryId: string;
  readonly dateKey: string;
  readonly targetStatus?: StatusValue;
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
 * (current -> `targetStatus`, default `WAITING`) is validated against the
 * active {@link ITransitionPolicy} — the same validator every queue action
 * uses (QUE-10 AC#3). An active state machine without the edge (the PRD §7
 * default has no `CALLING -> WAITING`) rejects the transfer with an
 * {@link InvalidStateTransitionException} (AC#2). The wizard/admin enables
 * transfer by adding the edge (e.g. `CALLING -> WAITING` labelled
 * "Pindah Kategori").
 *
 * The transition is pre-checked **before** reserving a new sequence number so
 * an illegal transfer does not burn or gap a per-category ticket number
 * (NFR-REL-02). On success a new number is issued via
 * {@link ISequenceRepository}, the aggregate's `transferTo` re-validates and
 * applies the reassignment, and the ticket is persisted.
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
  ) {}

  public async execute(command: TransferTicketCommand): Promise<TransferTicketResult> {
    // Resolve the active transition policy per execution (see CallNextTicketUseCase
    // for the rationale — the aggregate validates transitions synchronously).
    const transitionPolicy = await this.policyResolver.getActivePolicy();

    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }

    const targetStatus = command.targetStatus ?? TicketStatus.WAITING;
    // Pre-check before reserving a sequence number so an illegal transfer
    // does not advance (and thus gap) the per-category sequence (NFR-REL-02).
    if (!transitionPolicy.isAllowed(ticket.currentStatus, targetStatus)) {
      throw new InvalidStateTransitionException(ticket.currentStatus, targetStatus);
    }

    const category = await this.categories.getById(command.targetCategoryId);
    if (!category) {
      throw new EntityNotFoundException('Category', command.targetCategoryId);
    }

    const previousCategoryId = ticket.categoryId;
    const previousTicketNumber = ticket.ticketNumber.formatted();
    const newTicketNumber = await this.sequences.nextTicketNumber(
      command.targetCategoryId,
      category.code,
      command.dateKey,
    );

    ticket.transferTo(
      command.targetCategoryId,
      newTicketNumber,
      targetStatus,
      transitionPolicy,
      this.clock(),
    );
    await this.queue.save(ticket);
    // Drain the recorded TicketTransferredEvent + TicketStatusChangedEvent so
    // they broadcast (FR-ENG-04).
    await this.dispatcher.dispatch(ticket);

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