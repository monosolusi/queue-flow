import { DomainEvent } from '../../shared/domain-event';

/**
 * Emitted when the daily reset engine rolls the sequence back to its start
 * value. Broadcasts as SYSTEM_RESET (FR-ENG-04 / FR-ENG-05).
 */
export class DailyQueueResetEvent extends DomainEvent {
  constructor(
    aggregateId: string,
    public readonly resetTo: number,
    public readonly date: string,
    occurredAt?: number,
  ) {
    super(aggregateId, 'SYSTEM_RESET', 1, occurredAt);
  }
}