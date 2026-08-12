import { Module } from '@nestjs/common';
import { QueueEventDispatcher } from '../../application/queue/queue-event-dispatcher';
import {
  QUEUE_EVENT_PUBLISHER,
  type IQueueEventPublisher,
} from '../../domain/queue/event-publisher.port';
import { EVENT_DISPATCHER } from '../../domain/shared';
import { WebSocketEventPublisher } from '../../infrastructure/realtime/web-socket-event-publisher';
import { QueueRealtimeGateway } from './queue-realtime.gateway';
import { WireEventMapper } from './wire-event.mapper';

/**
 * Wires the local realtime broadcaster: the WS gateway (connection surface),
 * the wire mapper (domain → wire), the publisher (port implementation), and the
 * application-layer dispatcher (drain + publish). Exporting the dispatcher and
 * the {@link IQueueEventPublisher} port lets the QUE-9+ use-case modules inject
 * the seam without depending on the WebSocket transport.
 *
 * The dispatcher is also exported under the shared-kernel
 * {@link EVENT_DISPATCHER} token so a cross-context consumer (the Store Config
 * save use case, FR-CLR-02) can depend on the {@link IEventDispatcher} port in
 * `domain/shared` rather than on this Queue-owned concrete class — preserving
 * the bounded-context seam (DIP). Queue use cases still inject the
 * `QueueEventDispatcher` class token directly for the aggregate-draining
 * `dispatch` shape.
 */
@Module({
  providers: [
    QueueRealtimeGateway,
    WireEventMapper,
    { provide: QUEUE_EVENT_PUBLISHER, useClass: WebSocketEventPublisher },
    // Plain-class seam (no `@Injectable`): wire via a factory injecting the
    // publisher Symbol so the application layer stays framework-free
    // (NFR-MNT-01, `application-no-framework-imports`).
    {
      provide: QueueEventDispatcher,
      useFactory: (publisher: IQueueEventPublisher) => new QueueEventDispatcher(publisher),
      inject: [QUEUE_EVENT_PUBLISHER],
    },
    // Alias the same instance under the shared-kernel port token so cross-context
    // use cases inject the abstraction (DIP / bounded-context anti-corruption),
    // not this Queue-owned concrete class.
    { provide: EVENT_DISPATCHER, useExisting: QueueEventDispatcher },
  ],
  exports: [QueueEventDispatcher, EVENT_DISPATCHER, QUEUE_EVENT_PUBLISHER],
})
export class RealtimeModule {}