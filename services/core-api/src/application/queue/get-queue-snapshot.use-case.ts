import type { ICounterRoutingRuleRepository } from '../../domain/store-config';
import type { IQueueRepository } from '../../domain/queue';
import { EntityNotFoundException } from '../../domain/shared';
import { projectTicketState, type TicketStateDto } from './ticket-state.dto';

/**
 * Command for the counter-scoped queue snapshot read (FR-CLR-01 / QUE-19). The
 * caller workspace always binds a counter, so the snapshot is always scoped to
 * that counter's active ticket and the waiting queue for its assigned
 * categories.
 */
export interface GetQueueSnapshotCommand {
  readonly counterId: number;
}

/**
 * Read-side projection of the live queue state the caller workspace loads on
 * entry and keeps current via the WebSocket broadcaster (FR-ENG-04). Use cases
 * never return the aggregate itself — only this transport-agnostic DTO, which
 * the interface-adapter layer maps to HTTP (DIP / no domain leakage).
 *
 * `active` holds every CALLING / SERVING ticket at this counter; `waiting`
 * holds the WAITING tickets the counter is eligible to serve next (its
 * assigned categories), oldest first.
 */
export interface QueueSnapshotDto {
  readonly counterId: number;
  readonly active: readonly TicketStateDto[];
  readonly waiting: readonly TicketStateDto[];
  readonly waitingCount: number;
}

/**
 * Read-side use case: loads the active + waiting queue for a bound counter.
 * This is the "dimuat" (loaded) half of QUE-19's AC — the WebSocket broadcaster
 * handles the "diperbarui" (updated) half. A counter with no routing rule is a
 * configuration error (not an empty queue) and throws
 * {@link EntityNotFoundException}, consistent with {@link CallNextTicketUseCase}.
 *
 * Depends only on ports (DIP) — no ORM, HTTP framework, or I/O library — so
 * the application layer stays framework-free (NFR-MNT-01). Reuses
 * {@link projectTicketState} as the single ticket→DTO mapping; no second
 * projection is introduced.
 */
export class GetQueueSnapshotUseCase {
  constructor(
    private readonly queue: IQueueRepository,
    private readonly routingRules: ICounterRoutingRuleRepository,
  ) {}

  async execute(command: GetQueueSnapshotCommand): Promise<QueueSnapshotDto> {
    const rule = await this.routingRules.getByCounterId(command.counterId);
    if (!rule) {
      throw new EntityNotFoundException('CounterRoutingRule', String(command.counterId));
    }

    const [active, waiting] = await Promise.all([
      this.queue.findActiveByCounter(command.counterId),
      this.queue.findWaitingByCategories(rule.assignedCategoryIds),
    ]);

    return {
      counterId: command.counterId,
      active: active.map(projectTicketState),
      waiting: waiting.map(projectTicketState),
      waitingCount: waiting.length,
    };
  }
}