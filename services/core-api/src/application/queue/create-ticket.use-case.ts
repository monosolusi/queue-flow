import type {
  ICategoryRepository,
  IQueueRepository,
  ISequenceRepository,
} from '../../domain/queue';
import { QueueTicket, ticketIdGenerate } from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { QueueEventDispatcher } from './queue-event-dispatcher';

/**
 * Command for the kiosk "take a ticket" operation (FR-ENG-01). The visitor
 * selects a category; the use case mints a per-category, per-day ticket number
 * and enqueues the ticket. The kiosk does not supply a date — the daily
 * sequence key is derived from the injected clock so the date convention stays
 * in the application layer (out of the domain) and is deterministic in tests.
 */
export interface CreateTicketCommand {
  readonly categoryId: string;
}

/**
 * Projection of the newly created ticket returned to the interface-adapter
 * layer. Use cases never return the aggregate itself — only this
 * transport-agnostic DTO, which the controller/presenter maps to HTTP (DIP /
 * no domain leakage). The kiosk prints `ticketNumber` and displays `status`.
 */
export interface CreatedTicketDto {
  readonly ticketId: string;
  readonly ticketNumber: string;
  readonly categoryId: string;
  readonly status: string;
}

/** Outcome of "create ticket": the ticket is enqueued in WAITING. */
export type CreateTicketResult = {
  readonly status: 'created';
  readonly ticket: CreatedTicketDto;
};

/**
 * Formats an epoch-ms timestamp as a local `YYYY-MM-DD` date key. The system is
 * a single-store on-premise box (NFR-SEC-01), so the daily sequence boundary is
 * the store's *local* date — not UTC. Kept here in the application layer (not
 * the domain) so the date convention stays out of the pure domain model and is
 * unit-testable via an injected clock. `Date` is a language builtin, not an
 * I/O library, so it does not compromise layer purity.
 */
export function toDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * The ticket-generation use case (FR-ENG-01 / FR-ENG-05). Orchestrates taking a
 * ticket at the kiosk:
 *
 * 1. Resolves the selected {@link Category} (a missing category is a client
 *    / configuration error → `EntityNotFoundException`).
 * 2. Derives the per-day sequence key from the clock and atomically reserves
 *    the next per-category {@link TicketNumber} via {@link ISequenceRepository}
 *    — the port contract guarantees no duplicate numbers and no gaps, even
 *    across a crash/restart (NFR-REL-02).
 * 3. Mints a new {@link QueueTicket} (starts WAITING, records
 *    `TicketCreatedEvent`), persists it, and drains the event to the realtime
 *    broadcaster so the TV display updates immediately (FR-ENG-04).
 *
 * Depends only on ports (DIP): no ORM, HTTP framework, or I/O library — the
 * application layer stays framework-free, mirroring the Domain purity rule
 * (NFR-MNT-01). Concrete wiring (NestJS providers) is supplied by the
 * interface-adapter layer.
 *
 * NOTE: reserve → create → save is not atomic *within* the use case. True
 * gap-free durability (reserve the sequence and insert the ticket in one
 * database transaction, surviving a power cut mid-write) is the future
 * PostgreSQL repository's responsibility (QUE-28 / NFR-REL-02). The in-memory
 * implementation is for tests and local dev only. There is no pre-check that
 * can fail after a number is reserved — unlike {@link TransferTicketUseCase},
 * which pre-checks the transition before reserving — so a normal create burns
 * no sequence on a rejected command.
 */
export class CreateTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly categories: ICategoryRepository,
    private readonly sequences: ISequenceRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: CreateTicketCommand): Promise<CreateTicketResult> {
    const category = await this.categories.getById(command.categoryId);
    if (!category) {
      throw new EntityNotFoundException('Category', command.categoryId);
    }

    const now = this.clock();
    const dateKey = toDateKey(now);
    const ticketNumber = await this.sequences.nextTicketNumber(
      category.id.value,
      category.code,
      dateKey,
    );

    const ticket = QueueTicket.create(ticketIdGenerate(), ticketNumber, category.id.value, now);
    await this.queue.save(ticket);
    await this.dispatcher.dispatch(ticket);

    return {
      status: 'created',
      ticket: {
        ticketId: ticket.id.value,
        ticketNumber: ticket.ticketNumber.formatted(),
        categoryId: ticket.categoryId,
        status: ticket.currentStatus,
      },
    };
  }
}