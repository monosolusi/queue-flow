import { Module } from '@nestjs/common';
import { QueueEventDispatcher } from '../../application/queue/queue-event-dispatcher';
import {
  QUEUE_EVENT_PUBLISHER,
  type IQueueEventPublisher,
} from '../../domain/queue/event-publisher.port';
import { WebSocketEventPublisher } from '../../infrastructure/realtime/web-socket-event-publisher';
import { QueueRealtimeGateway } from './queue-realtime.gateway';
import { WireEventMapper } from './wire-event.mapper';

/**
 * Wires the local realtime broadcaster: the WS gateway (connection surface),
 * the wire mapper (domain → wire), the publisher (port implementation), and the
 * application-layer dispatcher (drain + publish). Exporting the dispatcher and
 * the {@link IQueueEventPublisher} port lets the QUE-9+ use-case modules inject
 * the seam without depending on the WebSocket transport.
 */
@Module({
  providers: [
    QueueRealtimeGateway,
    WireEventMapper,
    { provide: QUEUE_EVENT_PUBLISHER, useClass: WebSocketEventPublisher },
    QueueEventDispatcher,
  ],
  exports: [QueueEventDispatcher, QUEUE_EVENT_PUBLISHER],
})
export class RealtimeModule {}