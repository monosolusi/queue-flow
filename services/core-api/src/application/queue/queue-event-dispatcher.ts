import { Inject, Injectable } from '@nestjs/common';
import type { AggregateRoot } from '../../domain/shared/aggregate-root';
import type { DomainEvent } from '../../domain/shared/domain-event';
import {
  QUEUE_EVENT_PUBLISHER,
  type IQueueEventPublisher,
} from '../../domain/queue/event-publisher.port';

/**
 * Application-layer seam that drains the domain events recorded on an
 * aggregate and forwards them to the {@link IQueueEventPublisher} port. Use
 * cases call this after `repository.save(aggregate)` — the single place where
 * recorded events become realtime broadcasts (FR-ENG-04).
 *
 * Depends on the port, never on the WebSocket transport, so the application
 * layer stays decoupled from infrastructure (DIP).
 */
@Injectable()
export class QueueEventDispatcher {
  constructor(
    @Inject(QUEUE_EVENT_PUBLISHER)
    private readonly publisher: IQueueEventPublisher,
  ) {}

  public async dispatch(aggregate: AggregateRoot): Promise<void> {
    const events = aggregate.pullDomainEvents();
    if (events.length > 0) {
      await this.publisher.publish(events);
    }
  }

  /**
   * Publishes system-level {@link DomainEvent}s that are not owned by any
   * aggregate (e.g. {@link DailyQueueResetEvent} — the daily reset rolls the
   * whole sequence, not a single ticket, so there is no `AggregateRoot` to drain
   * via {@link dispatch}). Use cases call this after the system mutation
   * completes; it is the single place where those events become realtime
   * broadcasts (FR-ENG-04 / FR-ENG-05).
   *
   * Depends on the port, never on the WebSocket transport (DIP).
   */
  public async dispatchEvents(events: readonly DomainEvent[]): Promise<void> {
    if (events.length > 0) {
      await this.publisher.publish(events);
    }
  }
}