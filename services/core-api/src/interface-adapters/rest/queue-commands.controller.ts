import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApplyTransitionUseCase,
  CallNextTicketUseCase,
  ReannounceTicketUseCase,
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
    private readonly reannounceUseCase: ReannounceTicketUseCase,
    private readonly transferUseCase: TransferTicketUseCase,
    private readonly applyTransitionUseCase: ApplyTransitionUseCase,
  ) {}

  /** `POST /api/queue/call-next { counterId }` → the next ticket for the counter.
   *  Counter-level: it **picks** a ticket by routing + priority rather than acting
   *  on one the staff named, which is why it is not a per-ticket transition. */
  @Post('call-next')
  callNext(@Body() body: { counterId?: number | string }) {
    const counterId = parseCounterId(body?.counterId);
    return this.callNextUseCase.execute({ counterId });
  }

  /** `POST /api/queue/:ticketId/reannounce` → repeat the announcement for the
   *  currently-calling ticket ("Panggil Lagi"). Re-emits TICKET_CALLED without a
   *  state change, so it stays available on a flow that draws no
   *  `CALLING -> CALLING` edge; only valid from CALLING (a 409 otherwise). */
  @Post(':ticketId/reannounce')
  reannounce(@Param('ticketId') ticketId: string) {
    return this.reannounceUseCase.execute({ ticketId: parseTicketId(ticketId) });
  }

  /**
   * `POST /api/queue/:ticketId/transfer { targetCategoryId }` → "pindah kategori"
   * (FR-CLR-03). The one command beside {@link transition}, because it needs an
   * argument no flow can hold: the destination category, chosen by staff per
   * ticket. There is no target status — a transferred ticket always lands in
   * WAITING, which is what a re-issued per-category number means.
   *
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
   * `POST /api/queue/:ticketId/transition { targetStatus, counterId? }` → run one
   * configured transition of the active flow. **The** per-ticket state-change
   * endpoint: it accepts any target in the active schema — canonical or custom —
   * and the aggregate applies whatever side effects that target state carries
   * (announcement, service clock, re-queue). Illegal transitions surface as 409
   * `INVALID_STATE_TRANSITION`, unknown tickets as 404.
   *
   * `counterId` is the panel's bound counter; a transition into CALLING needs one
   * to announce the ticket at, falling back to the counter the ticket already
   * holds (400 when neither is available).
   *
   * There is no serve/complete/skip/recall endpoint beside it. Splitting per
   * target state meant something upstream had to decide which endpoint a given
   * `(from, to)` pair needed — a decision that cannot be derived from the pair,
   * and whose one rule for WAITING read every `X -> WAITING` edge as a category
   * move. An edge is now purely `from -> to + actionLabel`: what running it does
   * is owned by the target state, and "pindah kategori" is a standalone counter
   * action with its own endpoint ({@link transfer}), not a per-edge declaration.
   * So this endpoint runs any edge the active flow allows, including a `-> WAITING`
   * re-queue (number and category unchanged).
   */
  @Post(':ticketId/transition')
  transition(
    @Param('ticketId') ticketId: string,
    @Body() body: { targetStatus?: string; counterId?: number | string },
  ) {
    const targetStatus = body?.targetStatus;
    if (!targetStatus || !targetStatus.trim()) {
      throw new BadRequestException(
        "body field 'targetStatus' must be a non-empty string",
      );
    }
    return this.applyTransitionUseCase.execute({
      ticketId: parseTicketId(ticketId),
      targetStatus: targetStatus.trim(),
      // `== null` covers an explicit JSON `null` as well as an absent field: both
      // mean "no counter supplied", and the aggregate then falls back to the one
      // the ticket already holds. Routing `null` through `parseCounterId` would
      // 400 instead, defeating that fallback.
      counterId: body?.counterId == null ? null : parseCounterId(body.counterId),
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