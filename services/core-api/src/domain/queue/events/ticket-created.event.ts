import { DomainEvent } from '../../shared/domain-event';

/** Emitted when a new ticket is taken at the kiosk. Broadcasts as TICKET_CREATED (FR-ENG-04). */
export class TicketCreatedEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    public readonly ticketNumber: string,
    public readonly categoryId: string,
    occurredAt?: number,
  ) {
    super(aggregateId, 'TICKET_CREATED', 1, occurredAt);
  }
}