import type { Pool } from 'pg';
import { Identifier } from '../../../domain/shared/identifier';
import { CounterPerformance, DailyQueueReport } from '../../../domain/reporting';
import type { CategoryBreakdown, IReportQueryPort } from '../../../domain/reporting';
import { startOfLocalDayFromKey } from '../../../application/shared/date';
import { withDbClient } from './transaction-context';

/** Epoch-ms in one day. */
const MS_PER_DAY = 86_400_000;

/**
 * PostgreSQL {@link IReportQueryPort} (QUE-26, CQRS read side). Computes the
 * daily-report + counter-performance metrics in SQL over the same `tickets` +
 * `archived_tickets` tables the write side persists to — a past-day report
 * reads `archived_tickets` (the active table holds only the current day once a
 * reset-with-archive has run), a same-day report reads `tickets`. The
 * `UNION ALL` of both, filtered to the local-day window, covers either case.
 *
 * `AVG(...) FILTER (WHERE ...)` (Postgres) skips tickets that never reached the
 * transition — a CALLING-only ticket contributes to wait time but not service
 * time. `COALESCE(..., 0)` keeps the metric at 0 when no ticket reached the
 * transition. Reads enlist on the ambient transaction client via
 * {@link withDbClient} (read consistency with the rest of the repo pattern;
 * reads outside a tx just check a client out of the pool).
 */
export class PostgresReportQueryRepository implements IReportQueryPort {
  constructor(private readonly pool: Pool) {}

  async dailyReport(date: string): Promise<DailyQueueReport | null> {
    const dayStart = startOfLocalDayFromKey(date);
    const dayEnd = dayStart + MS_PER_DAY;
    return withDbClient(this.pool, async (client) => {
      const totals = await client.query<TotalsRow>(
        `WITH day_tickets AS (
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            COUNT(*)::int AS total_tickets,
            COALESCE(AVG(called_at - created_at) FILTER (WHERE called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(completed_at - served_at) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM day_tickets`,
        [dayStart, dayEnd],
      );
      const total = Number(totals.rows[0]?.total_tickets ?? 0);
      if (total === 0) return null;

      const perCat = await client.query<CategoryRow>(
        `WITH day_tickets AS (
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            c.id AS category_id,
            c.code AS code,
            COUNT(*)::int AS total_tickets,
            COALESCE(AVG(t.called_at - t.created_at) FILTER (WHERE t.called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(t.completed_at - t.served_at) FILTER (WHERE t.served_at IS NOT NULL AND t.completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM day_tickets t JOIN categories c ON c.id = t.category_id
          GROUP BY c.id, c.code
          ORDER BY c.code ASC`,
        [dayStart, dayEnd],
      );

      const perCategory: CategoryBreakdown[] = perCat.rows.map((r) => ({
        categoryId: r.category_id,
        code: r.code,
        totalTickets: Number(r.total_tickets),
        avgWaitTimeMs: Number(r.avg_wait_ms),
        avgServiceTimeMs: Number(r.avg_service_ms),
      }));

      return new DailyQueueReport(
        Identifier.generate(),
        date,
        total,
        Number(totals.rows[0].avg_wait_ms),
        Number(totals.rows[0].avg_service_ms),
        perCategory,
      );
    });
  }

  async counterPerformance(counterId: number, date: string): Promise<CounterPerformance | null> {
    const dayStart = startOfLocalDayFromKey(date);
    const dayEnd = dayStart + MS_PER_DAY;
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<CounterRow>(
        `WITH day_tickets AS (
            SELECT created_at, called_at, served_at, completed_at
            FROM tickets WHERE counter_id = $1 AND created_at >= $2 AND created_at < $3
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at
            FROM archived_tickets WHERE counter_id = $1 AND created_at >= $2 AND created_at < $3
          )
          SELECT
            COUNT(*) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL)::int AS tickets_served,
            COALESCE(AVG(completed_at - served_at) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL), 0)::bigint AS avg_service_ms,
            COUNT(*)::int AS total
          FROM day_tickets`,
        [counterId, dayStart, dayEnd],
      );
      const total = Number(rows[0]?.total ?? 0);
      if (total === 0) return null;
      return new CounterPerformance(
        Identifier.generate(),
        counterId,
        date,
        Number(rows[0].tickets_served),
        Number(rows[0].avg_service_ms),
      );
    });
  }
}

interface TotalsRow {
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
}
interface CategoryRow {
  category_id: string;
  code: string;
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
}
interface CounterRow {
  tickets_served: string | number;
  avg_service_ms: string | number;
  total: string | number;
}