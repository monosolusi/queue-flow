import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { GetQueueSnapshotUseCase, GetWaitingQueueUseCase } from '../../application/queue';

/**
 * Read-only REST surface for the live queue snapshot (FR-CLR-01 / QUE-19) and
 * the global waiting queue read consumed by the TV board. The caller workspace
 * calls this on entry to load its active ticket and the waiting queue for the
 * bound counter's categories; the WebSocket broadcaster (QUE-12) then keeps it
 * current. The TV board (no bound counter) reads the category-agnostic waiting
 * list via `GET /api/queue/waiting` and refetches after every lifecycle event.
 * Mutation endpoints arrive in QUE-20.
 *
 * The snapshot is always counter-scoped — the workspace always has a bound
 * counter — so `counterId` is required. A missing or non-integral `counterId`
 * is a client error (400); an unknown counter surfaces as 404 via the
 * {@link DomainExceptionFilter} (the use case throws `EntityNotFoundException`).
 */
@Controller('api/queue')
export class QueueController {
  constructor(
    private readonly getSnapshot: GetQueueSnapshotUseCase,
    private readonly getWaitingQueue: GetWaitingQueueUseCase,
  ) {}

  /** `GET /api/queue?counterId=N` → the counter-scoped queue snapshot. */
  @Get()
  snapshot(@Query('counterId') counterId?: string) {
    const parsed = Number.parseInt(counterId ?? '', 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException(
        "query param 'counterId' must be a positive integer",
      );
    }
    return this.getSnapshot.execute({ counterId: parsed });
  }

  /**
   * `GET /api/queue/waiting` → the global waiting queue (every WAITING ticket
   * across all categories, oldest first). Consumed by the TV board (no bound
   * counter); the server owns the read model, the TV refetches to stay current.
   */
  @Get('waiting')
  waiting() {
    return this.getWaitingQueue.execute();
  }
}