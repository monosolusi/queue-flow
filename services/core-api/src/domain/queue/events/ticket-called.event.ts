import { DomainEvent } from '../../shared/domain-event';

/** Emitted when a counter calls the next ticket. Broadcasts as TICKET_CALLED (FR-ENG-04). */
export class TicketCalledEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    public readonly ticketNumber: string,
    public readonly counterId: number,
    occurredAt?: number,
  ) {
    super(aggregateId, 'TICKET_CALLED', 1, occurredAt);
  }
}