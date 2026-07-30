import {
  IQueueRepository,
  NextTicketQuery,
  QueueTicket,
  TicketId,
  TicketStatus,
} from '../../../domain/queue';
import { PriorityPolicy } from '../../../domain/shared/priority-policy';

/**
 * In-memory implementation of {@link IQueueRepository} used by unit tests and
 * the development runtime (LSP — interchangeable with the future PostgreSQL
 * repository). Not for production; data is lost on restart.
 */
export class InMemoryQueueRepository implements IQueueRepository {
  private readonly tickets = new Map<string, QueueTicket>();

  async save(ticket: QueueTicket): Promise<void> {
    this.tickets.set(ticket.id.value, ticket);
  }

  async findById(id: TicketId): Promise<QueueTicket | null> {
    return this.tickets.get(id.value) ?? null;
  }

  async findWaitingByCategory(categoryId: string): Promise<QueueTicket[]> {
    return this.waiting()
      .filter((t) => t.categoryId === categoryId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async findWaitingByCategories(categoryIds: readonly string[]): Promise<QueueTicket[]> {
    const ids = new Set(categoryIds);
    return this.waiting()
      .filter((t) => ids.has(t.categoryId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async findActiveByCounter(counterId: number): Promise<QueueTicket[]> {
    return [...this.tickets.values()]
      .filter(
        (t) =>
          t.counterId === counterId &&
          (t.currentStatus === TicketStatus.CALLING ||
            t.currentStatus === TicketStatus.SERVING),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async findNextWaiting(query: NextTicketQuery): Promise<QueueTicket | null> {
    const candidates = this.waiting().filter((t) =>
      query.assignedCategoryIds.includes(t.categoryId),
    );
    if (candidates.length === 0) {
      return null;
    }
    if (query.priorityPolicy === PriorityPolicy.CATEGORY_PRIORITY) {
      candidates.sort((a, b) => {
        const ai = query.assignedCategoryIds.indexOf(a.categoryId);
        const bi = query.assignedCategoryIds.indexOf(b.categoryId);
        if (ai !== bi) {
          return ai - bi;
        }
        return a.createdAt - b.createdAt;
      });
    } else {
      candidates.sort((a, b) => a.createdAt - b.createdAt);
    }
    return candidates[0];
  }

  private waiting(): QueueTicket[] {
    return [...this.tickets.values()].filter(
      (t) => t.currentStatus === TicketStatus.WAITING,
    );
  }

  /** Test/dev-only: drops all stored tickets. Not on the port interface. */
  clear(): void {
    this.tickets.clear();
  }
}