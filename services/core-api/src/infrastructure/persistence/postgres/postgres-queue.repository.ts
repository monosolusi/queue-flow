import type { Pool } from 'pg';
import {
  type IQueueRepository,
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
export class PostgresQueueRepository implements IQueueRepository {
  constructor(private readonly pool: Pool) {}

  async save(ticket: QueueTicket): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO tickets (id, ticket_number, category_id, status, counter_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           ticket_number = EXCLUDED.ticket_number,
           category_id   = EXCLUDED.category_id,
           status        = EXCLUDED.status,
           counter_id    = EXCLUDED.counter_id,
           updated_at    = EXCLUDED.updated_at`,
        [
          ticket.id.value,
          ticket.ticketNumber.formatted(),
          ticket.categoryId,
          ticket.currentStatus,
          ticket.counterId,
          String(ticket.createdAt),
          String(ticket.updatedAt),
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
  });
}