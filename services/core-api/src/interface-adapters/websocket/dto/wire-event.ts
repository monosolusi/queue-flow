/**
 * Wire contract for queue lifecycle events broadcast over the local WebSocket
 * (FR-ENG-04). Every event a connected LAN client (TV display, caller panel,
 * admin monitor) receives conforms to this single envelope so subscribers can
 * switch on `type` and read a stable `payload` shape — regardless of which
 * bounded context produced the event.
 *
 * `type` mirrors the {@link DomainEvent.type} constants exactly
 * (TICKET_CREATED, TICKET_CALLED, STATUS_UPDATED, SYSTEM_RESET,
 * TICKET_TRANSFERRED).
 */
export type QueueLifecycleEventType =
  | 'TICKET_CREATED'
  | 'TICKET_CALLED'
  | 'STATUS_UPDATED'
  | 'SYSTEM_RESET'
  | 'TICKET_TRANSFERRED';

export interface TicketCreatedPayload {
  /** Formatted ticket number, e.g. "A-001". */
  ticketNumber: string;
  categoryId: string;
}

export interface TicketCalledPayload {
  ticketNumber: string;
  /** Counter the ticket was called to. */
  counterId: number;
}

export interface StatusUpdatedPayload {
  /** Previous status. */
  from: string;
  /** New status. */
  to: string;
  /** Indonesian action label shown on the caller UI, if any. */
  actionLabel: string | undefined;
}

export interface SystemResetPayload {
  /** Sequence value the daily reset rolled back to. */
  resetTo: number;
  /** ISO date the reset applied to. */
  date: string;
}

export interface TicketTransferredPayload {
  /** Category the ticket was moved from. */
  fromCategoryId: string;
  /** Category the ticket was moved to. */
  toCategoryId: string;
  /** Previous formatted ticket number, e.g. "A-001". */
  fromTicketNumber: string;
  /** New formatted ticket number issued under the target category. */
  toTicketNumber: string;
}

export type QueueLifecyclePayload =
  | TicketCreatedPayload
  | TicketCalledPayload
  | StatusUpdatedPayload
  | SystemResetPayload
  | TicketTransferredPayload;

export interface QueueLifecycleWireEvent {
  type: QueueLifecycleEventType;
  aggregateId: string;
  occurredAt: number;
  version: number;
  payload: QueueLifecyclePayload;
}