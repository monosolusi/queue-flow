import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { CreateTicketUseCase } from '../../application/queue';

/**
 * Kiosk ticket-creation REST surface (FR-ENG-01 / QUE-9). The kiosk touchscreen
 * POSTs the selected category here; the use case mints a per-category, per-day
 * ticket number (`A-001`, …) and enqueues the ticket, then the realtime
 * broadcaster (QUE-12) pushes the `TICKET_CREATED` event to the TV display.
 *
 * Path prefix `api/tickets` keeps it under the public `/api/*` REST surface,
 * distinct from the `/ws` path and the read-only caller endpoints in
 * {@link QueueController}. Caller command endpoints (call-next, serve, transfer,
 * …) are wired separately in QUE-20 — this controller owns only the kiosk's
 * take-a-ticket mutation.
 *
 * A missing/empty `categoryId` is a 400 client error; an unknown category
 * surfaces as 404 via the {@link DomainExceptionFilter} (the use case throws
 * `EntityNotFoundException`). On success Nest returns 201 (the default for
 * `@Post`) with the created-ticket DTO, which the kiosk prints/announces.
 */
@Controller('api/tickets')
export class TicketsController {
  constructor(private readonly createTicket: CreateTicketUseCase) {}

  /** `POST /api/tickets { categoryId }` → the newly created ticket. */
  @Post()
  create(@Body() body: { categoryId?: string }) {
    const categoryId = body?.categoryId;
    if (!categoryId || !categoryId.trim()) {
      throw new BadRequestException("body field 'categoryId' must be a non-empty string");
    }
    return this.createTicket.execute({ categoryId: categoryId.trim() });
  }
}