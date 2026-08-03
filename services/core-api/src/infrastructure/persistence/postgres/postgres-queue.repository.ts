import type { Pool } from 'pg';
import {
  type IQueueRepository,
  type ITicketArchivePort,
  type NextTicketQuery,
  QueueTicket,
  type TicketId,
  TicketStatus,
  ticketIdOf,
  TicketNumber,
} from '../../../domain/queue';
import { PriorityPolicy } from '../../../domain/shared';
import { txStorage, withDbClient } from './transaction-context';

interface TicketRow {
  id: string;
  ticket_number: string;
  category_id: string;
  status: string;
  counter_id: number | null;
  created_at: string;
  updated_at: string;
  called_at: string | null;
  served_at: string | null;
  completed_at: string | null;
}

/**
 * PostgreSQL implementation of {@link IQueueRepository} (QUE-30). LSP-
 * interchangeable with {@link InMemoryQueueRepository} behind the same port.
 *
 * `findNextWaiting` honors the routing query's priority policy. When called
 * inside a transaction it appends `FOR UPDATE` so two concurrent counters cannot
 * claim the same WAITING ticket — the second tx blocks on the row lock, then
 * re-reads under READ COMMITTED and sees the ticket is no longer WAITING.
 */
export class PostgresQueueRepository implements IQueueRepository, ITicketArchivePort {
  constructor(private readonly pool: Pool) {}

  async save(ticket: QueueTicket): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO tickets (id, ticket_number, category_id, status, counter_id, created_at, updated_at, called_at, served_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           ticket_number = EXCLUDED.ticket_number,
           category_id   = EXCLUDED.category_id,
           status        = EXCLUDED.status,
           counter_id    = EXCLUDED.counter_id,
           updated_at    = EXCLUDED.updated_at,
           called_at     = EXCLUDED.called_at,
           served_at     = EXCLUDED.served_at,
           completed_at  = EXCLUDED.completed_at`,
        [
          ticket.id.value,
          ticket.ticketNumber.formatted(),
          ticket.categoryId,
          ticket.currentStatus,
          ticket.counterId,
          ticket.createdAt,
          ticket.updatedAt,
          ticket.calledAt,
          ticket.servedAt,
          ticket.completedAt,
        ],
      );
    });
  }

  async findById(id: TicketId): Promise<QueueTicket | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<TicketRow>('SELECT * FROM tickets WHERE id = $1', [
        id.value,
      ]);
      return rows.length ? toTicket(rows[0]) : null;
    });
  }

  async findWaitingByCategory(categoryId: string): Promise<QueueTicket[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<TicketRow>(
        `SELECT * FROM tickets WHERE status = $1 AND category_id = $2 ORDER BY created_at ASC`,
        [TicketStatus.WAITING, categoryId],
      );
      return rows.map(toTicket);
    });
  }

  async findWaitingByCategories(categoryIds: readonly string[]): Promise<QueueTicket[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<TicketRow>(
        `SELECT * FROM tickets WHERE status = $1 AND category_id = ANY($2) ORDER BY created_at ASC`,
        [TicketStatus.WAITING, Array.from(categoryIds)],
      );
      return rows.map(toTicket);
    });
  }

  async countWaitingByCategory(categoryId: string): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count FROM tickets WHERE status = $1 AND category_id = $2`,
        [TicketStatus.WAITING, categoryId],
      );
      return Number(rows[0]?.count ?? 0);
    });
  }

  async findActiveByCounter(counterId: number): Promise<QueueTicket[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<TicketRow>(
        `SELECT * FROM tickets
         WHERE counter_id = $1 AND status IN ($2, $3)
         ORDER BY updated_at ASC`,
        [counterId, TicketStatus.CALLING, TicketStatus.SERVING],
      );
      return rows.map(toTicket);
    });
  }

  async findNextWaiting(query: NextTicketQuery): Promise<QueueTicket | null> {
    return withDbClient(this.pool, async (client) => {
      const cats = Array.from(query.assignedCategoryIds);
      const orderBy =
        query.priorityPolicy === PriorityPolicy.CATEGORY_PRIORITY
          ? 'array_position($2, category_id), created_at ASC'
          : 'created_at ASC';
      const forUpdate = txStorage.getStore() ? ' FOR UPDATE' : '';
      const { rows } = await client.query<TicketRow>(
        `SELECT * FROM tickets WHERE status = $1 AND category_id = ANY($2) ORDER BY ${orderBy}${forUpdate} LIMIT 1`,
        [TicketStatus.WAITING, cats],
      );
      return rows.length ? toTicket(rows[0]) : null;
    });
  }

  async archiveTicketsBefore(thresholdMs: number): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      // DELETE → archive in one CTE statement so the move is atomic; enlists on
      // the ambient reset transaction via withDbClient (NFR-REL-02). `rowCount`
      // is the number of rows inserted into the archive (= rows deleted).
      const { rowCount } = await client.query(
        `WITH moved AS (
           DELETE FROM tickets WHERE created_at < $1
           RETURNING id, ticket_number, category_id, status, counter_id, created_at, updated_at, called_at, served_at, completed_at
         )
         INSERT INTO archived_tickets (id, ticket_number, category_id, status, counter_id, created_at, updated_at, called_at, served_at, completed_at)
         SELECT id, ticket_number, category_id, status, counter_id, created_at, updated_at, called_at, served_at, completed_at FROM moved`,
        [thresholdMs],
      );
      return rowCount ?? 0;
    });
  }

  async purgeArchivedBefore(thresholdMs: number): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      // Permanently delete archived tickets older than the threshold (QUE-25 /
      // FR-ADM-02). The active `tickets` table and `audit_log` are never touched
      // — only `archived_tickets`. Enlists on the ambient cleanup transaction
      // via withDbClient so the purge + the TRANSACTION_LOG_CLEANUP audit record
      // commit atomically (NFR-REL-02).
      const { rowCount } = await client.query(
        'DELETE FROM archived_tickets WHERE created_at < $1',
        [thresholdMs],
      );
      return rowCount ?? 0;
    });
  }
}

function toTicket(row: TicketRow): QueueTicket {
  return QueueTicket.reconstitute({
    id: ticketIdOf(row.id),
    ticketNumber: TicketNumber.parse(row.ticket_number),
    categoryId: row.category_id,
    status: row.status,
    counterId: row.counter_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    calledAt: row.called_at === null ? null : Number(row.called_at),
    servedAt: row.served_at === null ? null : Number(row.served_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  });
}