import type { IQueueRepository } from '../../domain/queue';
import { projectTicketState, type TicketStateDto } from './ticket-state.dto';

/**
 * Read-side projection of the global waiting queue shown on the TV board
 * (FR-TV — the board has no bound counter, so the list is category-agnostic).
 * Use cases never return the aggregate itself — only this transport-agnostic
 * DTO, which the interface-adapter layer maps to HTTP (DIP / no domain
 * leakage). The TV refetches this read after every lifecycle event so the
 * server stays the single source of truth for the waiting list (the board
 * does not project waiting state from events).
 */
export interface WaitingQueueDto {
  /** All WAITING tickets, oldest first (FIFO by `createdAt`). */
  readonly waiting: readonly TicketStateDto[];
  /** Total count of WAITING tickets (`waiting.length`). */
  readonly waitingCount: number;
}

/**
 * Read-side use case: loads every WAITING ticket across all categories,
 * oldest first. The TV board (no bound counter) consumes this to render the
 * global waiting-queue panel.
 *
 * Depends only on a port (DIP) — no ORM, HTTP framework, or I/O library — so
 * the application layer stays framework-free (NFR-MNT-01). Reuses
 * {@link projectTicketState} as the single ticket→DTO mapping; no second
 * projection is introduced.
 */
export class GetWaitingQueueUseCase {
  constructor(private readonly queue: IQueueRepository) {}

  async execute(): Promise<WaitingQueueDto> {
    const waiting = await this.queue.findAllWaiting();
    return {
      waiting: waiting.map(projectTicketState),
      waitingCount: waiting.length,
    };
  }
}