import { Inject, Injectable } from '@nestjs/common';
import type { AggregateRoot } from '../../domain/shared/aggregate-root';
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
}