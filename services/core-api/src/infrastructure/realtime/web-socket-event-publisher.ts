import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '../../domain/shared/domain-event';
import { type IQueueEventPublisher } from '../../domain/queue/event-publisher.port';
import { QueueRealtimeGateway } from '../../interface-adapters/websocket/queue-realtime.gateway';
import { WireEventMapper } from '../../interface-adapters/websocket/wire-event.mapper';

/**
 * Infrastructure adapter that implements the {@link IQueueEventPublisher} port
 * by projecting each domain event onto the wire schema (via
 * {@link WireEventMapper}) and fanning it out to connected LAN clients through
 * the {@link QueueRealtimeGateway}. This is the concrete realtime broadcaster
 * for FR-ENG-04 / NFR-PERF-02.
 *
 * `publish` resolves once the envelopes have been handed to the gateway; the
 * gateway sends per-client without awaiting, so a slow receiver never blocks
 * the caller's transactional path.
 */
@Injectable()
export class WebSocketEventPublisher implements IQueueEventPublisher {
  constructor(
    private readonly gateway: QueueRealtimeGateway,
    private readonly mapper: WireEventMapper,
  ) {}

  public async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.gateway.broadcast(this.mapper.toWire(event));
    }
  }
}