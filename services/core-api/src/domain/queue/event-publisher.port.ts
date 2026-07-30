import type { DomainEvent } from '../shared/domain-event';

/**
 * NestJS DI token for {@link IQueueEventPublisher}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. It is a plain language builtin — no framework import — so
 * it does not compromise domain purity (NFR-MNT-01).
 */
export const QUEUE_EVENT_PUBLISHER = Symbol('QUEUE_EVENT_PUBLISHER');

/**
 * Port (interface) the application layer calls to publish the domain events a
 * {@link QueueTicket} recorded. Defined here — next to the events it carries —
 * per the Dependency Inversion Principle: the Queue context owns the
 * abstraction and never imports the WebSocket transport. The infrastructure
 * layer supplies the concrete implementation (the local WebSocket broadcaster
 * for FR-ENG-04 / NFR-PERF-02), so use cases stay decoupled from how events
 * reach LAN clients.
 */
export interface IQueueEventPublisher {
  /**
   * Forwards recorded domain events to connected clients. Implementations must
   * not throw on a disconnected client — a dropped receiver must not break the
   * caller's transactional path.
   */
  publish(events: readonly DomainEvent[]): Promise<void>;
}