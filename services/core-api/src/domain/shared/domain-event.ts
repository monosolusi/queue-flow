/**
 * Base contract for all domain events. Domain events represent something
 * meaningful that happened in the domain (a ticket was created, a status
 * changed, the daily queue was reset). They are immutable records of fact and
 * carry no framework dependency — infrastructure publishes them later.
 *
 * Event type names align with the realtime broadcast contract in FR-ENG-04
 * (TICKET_CREATED, TICKET_CALLED, STATUS_UPDATED, SYSTEM_RESET).
 */
export abstract class DomainEvent {
  public readonly occurredAt: number;
  public readonly version: number;

  constructor(
    public readonly aggregateId: string,
    public readonly type: string,
    version = 1,
    occurredAt?: number,
  ) {
    this.version = version;
    // Deterministic-when-supplied; otherwise the current epoch. Time is read
    // here (not in a workflow script), so Date.now() is available.
    this.occurredAt = occurredAt ?? Date.now();
  }
}