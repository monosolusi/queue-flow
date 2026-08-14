import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  GetBoardStateUseCase,
  GetQueueSnapshotUseCase,
  GetWorkflowActionsUseCase,
} from '../../application/queue';
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
 * event. The caller also reads its **dynamic action set** here
 * (`GET /api/queue/actions`) — the active workflow's edges already resolved to
 * the queue command that executes each one, so the panel's buttons follow the
 * configured graph instead of a client-side lookup table. Mutation endpoints
 * arrive in QUE-20.
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
    private readonly getWorkflowActions: GetWorkflowActionsUseCase,
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

  /**
   * `GET /api/queue/actions` → the active state machine's configured edges, keyed
   * by source status, each carrying the **action the manager declared** for it
   * (FR-CLR-02). The caller panel renders one button per entry and runs the
   * declared action; nothing here resolves an edge to a command.
   *
   * It used to: each edge was mapped to one of eight queue commands, keyed on the
   * `(from, to)` pair — which cannot say what the manager meant, so the rule for
   * WAITING read every `X -> WAITING` edge as a category move and turned a
   * re-queue into a "Pindah Kategori" button demanding a destination category.
   *
   * Authenticated (admin or caller-staff) via the controller-level guards — the
   * same classification as `GET /api/system/state-machine`, which serves the raw
   * graph this projection is derived from. Pre-setup it 409s
   * (`SystemNotConfiguredException` from the policy resolver), matching that
   * endpoint rather than inventing a second pre-setup behavior.
   */
  @Get('actions')
  actions() {
    return this.getWorkflowActions.execute();
  }
}