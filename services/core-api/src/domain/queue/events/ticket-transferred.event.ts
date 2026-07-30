import { DomainEvent } from '../../shared/domain-event';

/**
 * Emitted when a ticket is transferred to a different category (FR-CLR-03
 * "pindah kategori"). Carries both the old and new category and ticket number
 * so downstream displays / caller panels can re-sync on the re-issued number —
 * a `TicketStatusChangedEvent` alone would not reveal that the ticket's
 * identity-affecting attributes changed. Broadcasts as TICKET_TRANSFERRED
 * (FR-ENG-04).
 */
export class TicketTransferredEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    public readonly fromCategoryId: string,
    public readonly toCategoryId: string,
    public readonly fromTicketNumber: string,
    public readonly toTicketNumber: string,
    occurredAt?: number,
  ) {
    super(aggregateId, 'TICKET_TRANSFERRED', 1, occurredAt);
  }
}