import type { IQueueRepository } from '../../domain/queue';
import { projectTicketState, type TicketStateDto } from './ticket-state.dto';

/**
 * Read-side projection of the queue board state (FR-TV): the active tickets
 * (CALLING/SERVING across all counters, oldest-updated first) plus the global
 * waiting queue (every WAITING ticket across all categories, oldest first).
 * Use cases never return the aggregate itself — only this transport-agnostic
 * DTO, which the interface-adapter layer maps to HTTP (DIP / no domain
 * leakage). The board consumer (today the TV display) refetches this read
 * after every lifecycle event so the server stays the single source of truth
 * (the board does not project waiting state from events, and `nowServing` is
 * restored from the active slice on boot/refresh — fixing the "current antrian
 * tidak muncul" bug where a refresh left `nowServing` null because no
 * TICKET_CALLED event had fired yet).
 */
export interface TvBoardStateDto {
  /**
   * All CALLING/SERVING tickets across all counters, oldest-updated first
   * (ordered by `updatedAt` asc; the last is the most-recently-touched —
   * the TV projects that to `nowServing`).
   */
  readonly active: readonly TicketStateDto[];
  /** All WAITING tickets across all categories, oldest first (FIFO). */
  readonly waiting: readonly TicketStateDto[];
  /** Total count of WAITING tickets (`waiting.length`). */
  readonly waitingCount: number;
}

/**
 * Read-side use case: loads the queue board state — every active (CALLING/
 * SERVING) ticket across all counters plus every WAITING ticket across all
 * categories, oldest first. A board consumer with no bound counter (today the
 * TV display) consumes this to render the now-serving hero restored from the
 * server's active slice and the global waiting-queue panel.
 *
 * Consumer-agnostic (DDD ubiquitous language): the use case reads the queue,
 * not "the TV" — naming it after a frontend consumer would couple the
 * application layer to that consumer. The returned {@link TvBoardStateDto} is
 * the wire contract the board consumer reads; the `Tv` prefix lives on the DTO
 * (the consumer's slice), not on this use case.
 *
 * Depends only on a port (DIP) — no ORM, HTTP framework, or I/O library — so
 * the application layer stays framework-free (NFR-MNT-01). Reuses
 * {@link projectTicketState} as the single ticket→DTO mapping; no second
 * projection is introduced.
 */
export class GetBoardStateUseCase {
  constructor(private readonly queue: IQueueRepository) {}

  async execute(): Promise<TvBoardStateDto> {
    const [active, waiting] = await Promise.all([
      this.queue.findAllActive(),
      this.queue.findAllWaiting(),
    ]);
    return {
      active: active.map(projectTicketState),
      waiting: waiting.map(projectTicketState),
      waitingCount: waiting.length,
    };
  }
}