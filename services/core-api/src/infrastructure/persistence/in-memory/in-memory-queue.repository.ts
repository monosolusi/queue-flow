import {
  IQueueRepository,
  ITicketArchivePort,
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
export class InMemoryQueueRepository implements IQueueRepository, ITicketArchivePort {
  private readonly tickets = new Map<string, QueueTicket>();
  private readonly archivedTicketsList: QueueTicket[] = [];

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

  async findAllWaiting(): Promise<QueueTicket[]> {
    return this.waiting().sort((a, b) => a.createdAt - b.createdAt);
  }

  async countWaitingByCategory(categoryId: string): Promise<number> {
    return this.waiting().filter((t) => t.categoryId === categoryId).length;
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

  async archiveTicketsBefore(thresholdMs: number): Promise<number> {
    // Relocate every ticket older than the threshold (local midnight today)
    // into the archive list, removing it from the active store. Mirrors the
    // Postgres DELETE→archive move. NOTE: unlike the Postgres impl, this
    // mutation is NOT rolled back on a transaction failure — the in-memory
    // `NoOpTransactionManager` is a pure pass-through, so a `resetDaily`
    // throw after the archive leaves tickets moved-but-not-reset. This is the
    // documented dev-only limitation (gap-free durability is the Postgres
    // repo's job, per CLAUDE.md); do not treat the in-memory impl as a true
    // LSP substitute for the Postgres impl on the archive+reset failure path.
    const toMove = [...this.tickets.values()].filter((t) => t.createdAt < thresholdMs);
    for (const t of toMove) {
      this.tickets.delete(t.id.value);
    }
    this.archivedTicketsList.push(...toMove);
    return toMove.length;
  }

  async purgeArchivedBefore(thresholdMs: number): Promise<number> {
    // Permanently delete archived tickets older than the threshold (QUE-25 /
    // FR-ADM-02). The active store + audit log are never touched. NOTE: like
    // archiveTicketsBefore, this mutation is NOT rolled back on a transaction
    // failure — the in-memory NoOpTransactionManager is a pure pass-through, so
    // a cleanup throw after the purge leaves rows deleted-but-not-audited. This
    // is the documented dev-only limitation (gap-free durability is the
    // Postgres repo's job); do not treat the in-memory impl as a true LSP
    // substitute for the Postgres impl on the purge+audit failure path.
    const before = this.archivedTicketsList.length;
    for (let i = this.archivedTicketsList.length - 1; i >= 0; i--) {
      if (this.archivedTicketsList[i].createdAt < thresholdMs) {
        this.archivedTicketsList.splice(i, 1);
      }
    }
    return before - this.archivedTicketsList.length;
  }

  private waiting(): QueueTicket[] {
    return [...this.tickets.values()].filter(
      (t) => t.currentStatus === TicketStatus.WAITING,
    );
  }

  /** Test/dev-only: drops all stored tickets (active + archived). Not on the port interface. */
  clear(): void {
    this.tickets.clear();
    this.archivedTicketsList.length = 0;
  }

  /** Test/dev-only: snapshot of tickets relocated to the archive store. Not on the port interface. */
  archivedTickets(): readonly QueueTicket[] {
    return [...this.archivedTicketsList];
  }

  /**
   * Read-side accessor for the in-memory {@link IReportQueryPort} impl (QUE-26):
   * every ticket still in the active store. Not on the port interface — the
   * write-side `IQueueRepository` exposes only the query methods the caller / use
   * cases need, so listing all tickets is a reporting-only seam. The in-memory
   * report repo combines this with {@link archivedTickets} to compute a daily
   * report over the same store the live queue uses (CQRS read side sharing the
   * in-memory write side, dev/test only). The Postgres report repo needs no such
   * seam — it reads `tickets` + `archived_tickets` directly via SQL.
   */
  allActive(): readonly QueueTicket[] {
    return [...this.tickets.values()];
  }
}