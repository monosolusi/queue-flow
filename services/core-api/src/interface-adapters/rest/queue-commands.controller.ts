import { BadRequestException, Body, Controller, Param, Post } from '@nestjs/common';
import {
  CallNextTicketUseCase,
  CompleteTicketUseCase,
  RecallTicketUseCase,
  ServeTicketUseCase,
  SkipTicketUseCase,
  TransferTicketUseCase,
} from '../../application/queue';
import { toDateKey } from '../../application/queue';
import { ticketIdOf } from '../../domain/queue';

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
export class QueueCommandsController {
  constructor(
    private readonly callNextUseCase: CallNextTicketUseCase,
    private readonly serveUseCase: ServeTicketUseCase,
    private readonly completeUseCase: CompleteTicketUseCase,
    private readonly skipUseCase: SkipTicketUseCase,
    private readonly recallUseCase: RecallTicketUseCase,
    private readonly transferUseCase: TransferTicketUseCase,
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