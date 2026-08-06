import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GetBoardStateUseCase, GetQueueSnapshotUseCase } from '../../application/queue';
import { Role } from '../../domain/identity';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';

/**
 * Read-only REST surface for the live queue snapshot (FR-CLR-01 / QUE-19) and
 * the queue board state read. The caller workspace calls this on entry to load
 * its active ticket and the waiting queue for the bound counter's categories;
 * the WebSocket broadcaster (QUE-12) then keeps it current. A board consumer
 * with no bound counter (today the TV display) reads its full state — active
 * (CALLING/SERVING) tickets to restore `nowServing` on refresh + the global
 * waiting list — via `GET /api/queue/board` and refetches after every lifecycle
 * event. Mutation endpoints arrive in QUE-20.
 *
 * The snapshot is always counter-scoped — the workspace always has a bound
 * counter — so `counterId` is required. A missing or non-integral `counterId`
 * is a client error (400); an unknown counter surfaces as 404 via the
 * {@link DomainExceptionFilter} (the use case throws `EntityNotFoundException`).
 */
@Controller('api/queue')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.CALLER_STAFF)
export class QueueController {
  constructor(
    private readonly getSnapshot: GetQueueSnapshotUseCase,
    private readonly getBoardState: GetBoardStateUseCase,
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
   * `GET /api/queue/board` → the queue board state: every active (CALLING/
   * SERVING) ticket across all counters (ordered by `updatedAt` asc — the last
   * is the most-recently-touched, which a board consumer projects to
   * `nowServing`) plus every WAITING ticket across all categories, oldest
   * first. Consumed by a board consumer with no bound counter (today the TV
   * display); the server owns the read model, the consumer refetches to stay
   * current and to restore `nowServing` on a fresh page load.
   */
  @Get('board')
  @Public()
  board() {
    return this.getBoardState.execute();
  }
}