import type {
  ICategoryRepository,
  IQueueRepository,
  ISequenceRepository,
} from '../../domain/queue';
import { QueueTicket, ticketIdGenerate } from '../../domain/queue';
import { EntityNotFoundException, ITransactionManager, NoOpTransactionManager } from '../../domain/shared';
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
 * Local-date helpers (re-exported from `application/shared/date` — QUE-26).
 * The date convention is shared across bounded contexts (queue sequence key,
 * daily-reset archive threshold, reporting day window), so it lives in
 * `application/shared` and is re-exported here for the queue-context consumers
 * and tests that already import it from `application/queue`. See
 * {@link toDateKey} / {@link startOfLocalDay} for the single-store on-premise
 * local-date rationale (NFR-SEC-01).
 *
 * The `import` (in addition to the `export … from`) is required because a
 * re-export does not bring the names into this module's local scope — the
 * use-case body below calls `toDateKey(now)`, so it needs a local binding.
 */
import { toDateKey } from '../shared/date';
export { toDateKey, startOfLocalDay } from '../shared/date';

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
 * NOTE: reserve → create → save is wrapped in a single {@link
 * ITransactionManager} transaction so a durable (PostgreSQL) implementation
 * commits the sequence reservation and the ticket insert atomically — a power
 * cut mid-write rolls the sequence advance back too, so no duplicate numbers
 * and no gaps (NFR-REL-02, QUE-30). The in-memory / no-op transaction manager is
 * a pure pass-through, so tests and local dev behave exactly as before. There
 * is no pre-check that can fail after a number is reserved — unlike {@link
 * TransferTicketUseCase}, which pre-checks the transition before reserving —
 * so a normal create burns no sequence on a rejected command.
 */
export class CreateTicketUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly categories: ICategoryRepository,
    private readonly sequences: ISequenceRepository,
    private readonly dispatcher: QueueEventDispatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: CreateTicketCommand): Promise<CreateTicketResult> {
    const category = await this.categories.getById(command.categoryId);
    if (!category) {
      throw new EntityNotFoundException('Category', command.categoryId);
    }

    // Reserve + persist inside one transaction so a durable implementation
    // commits the sequence reservation and ticket insert atomically (NFR-REL-
    // 02). The realtime broadcast is drained *after* the commit so we never
    // announce a state change that rolled back.
    const ticket = await this.txManager.runInTransaction(async () => {
      const now = this.clock();
      const dateKey = toDateKey(now);
      const ticketNumber = await this.sequences.nextTicketNumber(
        category.id.value,
        category.code,
        dateKey,
      );
      const created = QueueTicket.create(ticketIdGenerate(), ticketNumber, category.id.value, now);
      await this.queue.save(created);
      return created;
    });

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