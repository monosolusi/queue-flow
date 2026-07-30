import type { QueueTicket } from '../queue-ticket.aggregate';
import type { TicketId } from '../value-objects/ticket-id';
import type { PriorityPolicy } from '../../shared/priority-policy';

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
}