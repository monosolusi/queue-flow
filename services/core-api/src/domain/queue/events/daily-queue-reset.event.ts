import { DomainEvent } from '../../shared/domain-event';

/**
 * Sentinel `aggregateId` for system-wide events that are not owned by any
 * aggregate (the daily reset rolls the whole sequence, not a single ticket).
 * `DomainEvent` requires an `aggregateId`, so system events reference this
 * stable constant rather than a magic string — the wire mapper and any future
 * audit consumer key off it. If more system events appear, revisit and introduce
 * a dedicated `SystemAggregate` (QUE-2 scope has exactly one).
 */
export const SYSTEM_AGGREGATE_ID = 'system';

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