import type { QueueTicket } from '../queue-ticket.aggregate';
import type { TicketId } from '../value-objects/ticket-id';
import type { PriorityPolicy } from '../../shared/priority-policy';

/**
 * NestJS DI token for {@link IQueueRepository}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather
 * than by type metadata. It is a plain language builtin — no framework import
 * — so it does not compromise domain purity (NFR-MNT-01), mirroring the
 * {@link QUEUE_EVENT_PUBLISHER} pattern.
 */
export const QUEUE_REPOSITORY = Symbol('QUEUE_REPOSITORY');

/**
 * Selection parameters for "call next" (FR-ENG-03). Translated from a
 * {@link CounterRoutingRule} by the use case layer so the Queue context does
 * not depend on Store Config internals.
 */
export interface NextTicketQuery {
  readonly assignedCategoryIds: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

/**
 * Repository abstraction for the Queue aggregate (LSP: PostgreSQL and
 * InMemory implementations are interchangeable). Consumed by the use case
 * layer; implemented by infrastructure.
 */
export interface IQueueRepository {
  /** Upserts the ticket by identity (insert-or-update). */
  save(ticket: QueueTicket): Promise<void>;
  findById(id: TicketId): Promise<QueueTicket | null>;
  findWaitingByCategory(categoryId: string): Promise<QueueTicket[]>;
  /** Selects the next WAITING ticket honoring the routing query's priority policy. */
  findNextWaiting(query: NextTicketQuery): Promise<QueueTicket | null>;
  /**
   * Tickets currently being handled at `counterId` — those in CALLING or
   * SERVING with that counter assigned. Used by the read side (caller
   * workspace "tiket aktif" view); ordered by `updatedAt` asc so the most
   * recently touched active ticket is last.
   */
  findActiveByCounter(counterId: number): Promise<QueueTicket[]>;
  /**
   * All WAITING tickets whose category is in `categoryIds`, ordered oldest
   * first (FIFO by `createdAt`). The multi-category read counterpart to
   * {@link findWaitingByCategory}; used by the caller workspace to render the
   * waiting queue for a counter's assigned categories.
   */
  findWaitingByCategories(categoryIds: readonly string[]): Promise<QueueTicket[]>;
  /**
   * Count of tickets currently WAITING in `categoryId` (FR-KSK-03 — the kiosk
   * receipt prints the visitor's queue position). A dedicated COUNT read is
   * cheaper than loading aggregates via {@link findWaitingByCategory} and keeps
   * the count read distinct (SRP). When called inside a transaction it sees the
   * just-inserted row (the same Postgres tx) and excludes concurrent uncommitted
   * inserts, so the count is deterministic.
   */
  countWaitingByCategory(categoryId: string): Promise<number>;
}