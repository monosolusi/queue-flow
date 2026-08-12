import { DomainEvent } from '../../shared/domain-event';

/**
 * Sentinel `aggregateId` for system-wide events that are not owned by any
 * aggregate (the daily reset rolls the whole sequence, not a single ticket).
 * Now lives in the shared kernel ({@link SYSTEM_AGGREGATE_ID}) so every context's
 * system events reference the same constant; re-exported here so existing
 * `import { SYSTEM_AGGREGATE_ID } from '../../domain/queue'` keep working.
 */
export { SYSTEM_AGGREGATE_ID } from '../../shared/system-aggregate-id';

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