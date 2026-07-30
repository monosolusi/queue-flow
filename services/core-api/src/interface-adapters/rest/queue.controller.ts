import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { GetQueueSnapshotUseCase } from '../../application/queue';

/**
 * Read-only REST surface for the live queue snapshot (FR-CLR-01 / QUE-19).
 * The caller workspace calls this on entry to load its active ticket and the
 * waiting queue for the bound counter's categories; the WebSocket broadcaster
 * (QUE-12) then keeps it current. Mutation endpoints arrive in QUE-20.
 *
 * The snapshot is always counter-scoped — the workspace always has a bound
 * counter — so `counterId` is required. A missing or non-integral `counterId`
 * is a client error (400); an unknown counter surfaces as 404 via the
 * {@link DomainExceptionFilter} (the use case throws `EntityNotFoundException`).
 */
@Controller('api/queue')
export class QueueController {
  constructor(private readonly getSnapshot: GetQueueSnapshotUseCase) {}

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
}