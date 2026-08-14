import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  acceptsGenericTransitionTarget,
  ApplyTransitionUseCase,
  CallNextTicketUseCase,
  CompleteTicketUseCase,
  RecallTicketUseCase,
  ReannounceTicketUseCase,
  ServeTicketUseCase,
  SkipTicketUseCase,
  TransferTicketUseCase,
} from '../../application/queue';
import { toDateKey } from '../../application/shared/date';
import { ticketIdOf } from '../../domain/queue';
import { Role } from '../../domain/identity';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

/**
 * Queue command REST surface (FR-ENG-03 / FR-CLR-03, QUE-2). The caller panel
 * POSTs queue-control actions here; each use case validates the transition
 * against the active state machine, persists, and broadcasts the lifecycle event
 * (TICKET_CALLED / STATUS_UPDATED / TICKET_TRANSFERRED) over the WebSocket
 * broadcaster (QUE-12). Illegal transitions surface as 409 via the
 * {@link DomainExceptionFilter}; unknown tickets/categories as 404.
 *
 * Shares the `api/queue` prefix with the read-only {@link QueueController}
 * (GET /api/queue) — the queue resource reads its snapshot and accepts control
 * commands under one prefix, with commands as POST sub-paths.
 */
@Controller('api/queue')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.CALLER_STAFF)
export class QueueCommandsController {
  constructor(
    private readonly callNextUseCase: CallNextTicketUseCase,
    private readonly serveUseCase: ServeTicketUseCase,
    private readonly completeUseCase: CompleteTicketUseCase,
    private readonly skipUseCase: SkipTicketUseCase,
    private readonly recallUseCase: RecallTicketUseCase,
    private readonly reannounceUseCase: ReannounceTicketUseCase,
    private readonly transferUseCase: TransferTicketUseCase,
    private readonly applyTransitionUseCase: ApplyTransitionUseCase,
  ) {}

  /** `POST /api/queue/call-next { counterId }` → the next ticket for the counter. */
  @Post('call-next')
  callNext(@Body() body: { counterId?: number | string }) {
    const counterId = parseCounterId(body?.counterId);
    return this.callNextUseCase.execute({ counterId });
  }

  /** `POST /api/queue/:ticketId/serve` → begin serving the called ticket. */
  @Post(':ticketId/serve')
  serve(@Param('ticketId') ticketId: string) {
    return this.serveUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /** `POST /api/queue/:ticketId/complete` → end service on the served ticket. */
  @Post(':ticketId/complete')
  complete(@Param('ticketId') ticketId: string) {
    return this.completeUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /** `POST /api/queue/:ticketId/skip` → mark the called ticket as skipped. */
  @Post(':ticketId/skip')
  skip(@Param('ticketId') ticketId: string) {
    return this.skipUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /** `POST /api/queue/:ticketId/recall` → re-call a previously skipped ticket. */
  @Post(':ticketId/recall')
  recall(@Param('ticketId') ticketId: string) {
    return this.recallUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /** `POST /api/queue/:ticketId/reannounce` → re-announce the currently-calling
   *  ticket ("Panggil Lagi"). Re-emits TICKET_CALLED without a state change;
   *  only valid from CALLING (a 409 otherwise). */
  @Post(':ticketId/reannounce')
  reannounce(@Param('ticketId') ticketId: string) {
    return this.reannounceUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /**
   * `POST /api/queue/:ticketId/transfer { targetCategoryId }` → "pindah kategori".
   * `dateKey` is today's per-day sequence key, derived here (interface-adapter)
   * so the use case stays anti-corruption-clean (no Store-Config import) and the
   * date convention remains in the application layer via {@link toDateKey}.
   */
  @Post(':ticketId/transfer')
  transfer(
    @Param('ticketId') ticketId: string,
    @Body() body: { targetCategoryId?: string },
  ) {
    const targetCategoryId = body?.targetCategoryId;
    if (!targetCategoryId || !targetCategoryId.trim()) {
      throw new BadRequestException(
        "body field 'targetCategoryId' must be a non-empty string",
      );
    }
    return this.transferUseCase.execute({
      ticketId: parseTicketId(ticketId),
      targetCategoryId: targetCategoryId.trim(),
      dateKey: toDateKey(Date.now()),
    });
  }

  /**
   * `POST /api/queue/:ticketId/transition { targetStatus }` → apply a generic,
   * wizard-configurable transition to an arbitrary **custom** target state
   * (QUE-33). The backing for every `action_label` that does not map to one of
   * the six fixed commands — a plain status change (STATUS_UPDATED) with no
   * lifecycle timestamp / counter / number side effects. Illegal transitions
   * surface as 409 `INVALID_STATE_TRANSITION`, unknown tickets as 404.
   *
   * The five PRD-default states each have a dedicated command endpoint
   * (call-next/serve/complete/skip/recall/transfer) whose aggregates own the
   * domain-specific side effects (lifecycle timestamps, counter/number
   * reassignment). The generic endpoint is for **custom** targets only: a
   * canonical target is rejected with 400 so a direct API call cannot bypass
   * those named transitions and silently corrupt the QUE-26 analytics data
   * model (e.g. a `COMPLETED` reached via this path would leave `completedAt`
   * null). That admission rule is {@link acceptsGenericTransitionTarget} — the
   * same function `GetWorkflowActionsUseCase` consults when it tells the caller
   * which edges the `APPLY_TRANSITION` command realizes, so the endpoint and the
   * published routing cannot drift. The caller no longer routes edges itself: it
   * renders the command `GET /api/queue/actions` names for each edge.
   */
  @Post(':ticketId/transition')
  transition(
    @Param('ticketId') ticketId: string,
    @Body() body: { targetStatus?: string },
  ) {
    const targetStatus = body?.targetStatus;
    if (!targetStatus || !targetStatus.trim()) {
      throw new BadRequestException(
        "body field 'targetStatus' must be a non-empty string",
      );
    }
    const target = targetStatus.trim();
    if (!acceptsGenericTransitionTarget(target)) {
      throw new BadRequestException(
        `targetStatus '${target}' has a dedicated command endpoint; use that instead`,
      );
    }
    return this.applyTransitionUseCase.execute({
      ticketId: parseTicketId(ticketId),
      targetStatus: target,
    });
  }
}

function parseCounterId(raw: number | string | undefined): number {
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestException("'counterId' must be a positive integer");
  }
  return parsed;
}

function parseTicketId(raw: string): ReturnType<typeof ticketIdOf> {
  if (!raw || !raw.trim()) {
    throw new BadRequestException("'ticketId' path param must be a non-empty string");
  }
  return ticketIdOf(raw.trim());
}