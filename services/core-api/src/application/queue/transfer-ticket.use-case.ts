import type {
  ICategoryRepository,
  IQueueRepository,
  ISequenceRepository,
  TicketId,
} from '../../domain/queue';
import { TicketStatus } from '../../domain/queue';
import {
  EntityNotFoundException,
  InvalidArgumentException,
  ITransactionManager,
  NoOpTransactionManager,
} from '../../domain/shared';
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
 * Transfer is a **standalone counter action**, decoupled from the flow: it is
 * not a configured edge, needs no `X -> WAITING` edge declared, and consults no
 * {@link ITransitionPolicy}. The flow only draws state moves; a category move
 * takes a destination the flow cannot supply (staff pick it per ticket), so it
 * is its own command. A re-queue `-> WAITING` that keeps the ticket's number and
 * category is a plain status change (`ApplyTransitionUseCase`), not a transfer.
 *
 * A transfer always lands in WAITING with a re-issued per-category number — that
 * is what a fresh `B-001` means (a ticket nobody has served). The category is
 * reassigned, the counter cleared, and the ticket re-enters the queue under the
 * new category.
 *
 * Defense-in-depth: a `COMPLETED` ticket cannot be re-queued via transfer, and a
 * transfer to the ticket's *own* category is rejected — both **before** reserving
 * a new sequence number so an illegal transfer burns no per-category number
 * (NFR-REL-02). The caller panel only offers transfer on an active non-terminal
 * ticket, so these guards are a safety net, not the gate.
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
 * Depends only on ports (DIP): no `ITransitionPolicyResolver` — transfer is
 * flow-decoupled, so the use case needs no active state machine.
 */
export class TransferTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly categories: ICategoryRepository,
    private readonly sequences: ISequenceRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: TransferTicketCommand): Promise<TransferTicketResult> {
    const ticket = await this.queue.findById(command.ticketId);
    if (!ticket) {
      throw new EntityNotFoundException('QueueTicket', command.ticketId.value);
    }

    // Defense-in-depth: a completed ticket cannot be re-queued via transfer. The
    // caller panel only offers transfer on an active non-terminal ticket, so this
    // is a safety net for a direct API call. Checked before reserving a sequence
    // number so an illegal transfer burns no per-category number (NFR-REL-02).
    if (ticket.currentStatus === TicketStatus.COMPLETED) {
      throw new InvalidArgumentException(
        'A completed ticket cannot be transferred back to the queue',
      );
    }

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
        // The event label is a fixed constant (PRD FR-CLR-03), not read from the
        // flow — transfer is flow-decoupled, so no edge supplies a label.
        'Pindah Kategori',
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