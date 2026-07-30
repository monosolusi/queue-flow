import { DomainEvent } from '../../shared/domain-event';

/** Emitted whenever a ticket's status changes. Broadcasts as STATUS_UPDATED (FR-ENG-04). */
export class TicketStatusChangedEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    public readonly from: string,
    public readonly to: string,
    public readonly actionLabel: string | undefined,
    occurredAt?: number,
  ) {
    super(aggregateId, 'STATUS_UPDATED', 1, occurredAt);
  }
}