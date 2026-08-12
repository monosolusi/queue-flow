import type { DomainEvent } from './domain-event';

/**
 * NestJS DI token for {@link IEventDispatcher}. Interfaces are erased at runtime,
 * so the application layer injects the port by this Symbol rather than by type
 * metadata. A plain language builtin — no framework import — so it does not
 * compromise domain purity (NFR-MNT-01), mirroring {@link TRANSACTION_MANAGER} /
 * {@link DAILY_RESET_SCHEDULER}.
 *
 * FR-CLR-02: a system-configuration save broadcasts a
 * {@link SystemConfigurationChangedEvent} post-commit so connected caller panels
 * refetch the active state machine and reflect the admin-designed flow + its
 * `actionLabel` wording without a page reload. The Store Config use case owns
 * the broadcast decision but must not depend on the Queue context's
 * application layer (the concrete `QueueEventDispatcher`) to publish it — that
 * would be the only `application/store-config → application/queue` reach in the
 * codebase, bending DIP and eroding the bounded-context seam every other
 * cross-context dependency respects (scheduler, tx manager, audit, repos all go
 * through ports). This port is the shared-kernel abstraction the use case
 * depends on instead (DIP); `RealtimeModule` wires the Queue-owned
 * `QueueEventDispatcher` — which `implements IEventDispatcher` — under this
 * token, so the cross-context dependency points at the abstraction, not the
 * concrete class.
 *
 * Non-repository domain port, like {@link ITransactionManager}: a pure
 * interface + Symbol token with no framework/IO imports, so domain purity
 * (NFR-MNT-01) holds.
 */
export const EVENT_DISPATCHER = Symbol('EVENT_DISPATCHER');

/**
 * Broadcasts system-level {@link DomainEvent}s — events not owned by any
 * aggregate, such as {@link SystemConfigurationChangedEvent} — to realtime
 * clients. Consumers in any bounded context depend on this abstraction, never
 * on a concrete dispatcher owned by another context (DIP / bounded-context
 * anti-corruption). The concrete implementation drains into the
 * {@link IQueueEventPublisher} WebSocket transport.
 *
 * The port is intentionally minimal — a single `dispatchEvents` — so a context
 * that only needs to announce system events (Store Config) does not depend on
 * the aggregate-draining `dispatch(aggregate)` shape the Queue context's own
 * use cases use (ISP). Callers MUST invoke `dispatchEvents` only after the
 * originating mutation has committed (post-commit), never inside the
 * transaction: a rolled-back save must never announce an un-persisted change
 * (NFR-REL-02).
 */
export interface IEventDispatcher {
  /**
   * Publish the given system-level {@link DomainEvent}s so they become realtime
   * broadcasts. Implementations SHOULD be a no-op for an empty input (mirrors
   * `QueueEventDispatcher.dispatchEvents`) so callers can fire unconditionally
   * without guarding the count.
   */
  dispatchEvents(events: readonly DomainEvent[]): Promise<void>;
}