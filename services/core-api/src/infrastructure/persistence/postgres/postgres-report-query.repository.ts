import type { Pool } from 'pg';
import { Identifier } from '../../../domain/shared/identifier';
import {
  CounterPerformance,
  DailyQueueReport,
  RangeQueueReport,
} from '../../../domain/reporting';
import type {
  CategoryBreakdown,
  CounterRangeBreakdown,
  DailyPoint,
  IReportQueryPort,
} from '../../../domain/reporting';
import { startOfLocalDayFromKey, toDateKey } from '../../../application/shared/date';
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
            c.name AS category_name,
            COUNT(*)::int AS total_tickets,
            COALESCE(AVG(t.called_at - t.created_at) FILTER (WHERE t.called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(t.completed_at - t.served_at) FILTER (WHERE t.served_at IS NOT NULL AND t.completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM day_tickets t JOIN categories c ON c.id = t.category_id
          GROUP BY c.id, c.code, c.name
          ORDER BY c.code ASC`,
        [dayStart, dayEnd],
      );

      const perCategory: CategoryBreakdown[] = perCat.rows.map((r) => ({
        categoryId: r.category_id,
        code: r.code,
        categoryName: r.category_name,
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

  async rangeReport(from: string, to: string): Promise<RangeQueueReport | null> {
    const fromStart = startOfLocalDayFromKey(from);
    const toEnd = startOfLocalDayFromKey(to) + MS_PER_DAY;
    return withDbClient(this.pool, async (client) => {
      // Range totals first — if no tickets exist in the range, return null so
      // the controller materializes the empty-range shape (with a per-day zero
      // series). Avoids running the three breakdown queries on an empty range.
      const totals = await client.query<RangeTotalsRow>(
        `WITH range_tickets AS (
            SELECT created_at, called_at, served_at, completed_at
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            COUNT(*)::int AS total_tickets,
            COALESCE(AVG(called_at - created_at) FILTER (WHERE called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(completed_at - served_at) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM range_tickets`,
        [fromStart, toEnd],
      );
      const total = Number(totals.rows[0]?.total_tickets ?? 0);
      if (total === 0) return null;

      // Per-day series via a recursive day-window CTE LEFT JOINed to the range
      // tickets, so days with no tickets surface as zero-point rows (a
      // continuous trend axis). The CTE is bounded by `toEnd` (and the use case
      // caps the span at 90 days), so it cannot run away. The `date` string is
      // derived from the epoch `day_start` in TS via `toDateKey` — keeps the
      // SQL timezone-agnostic and the date convention owned by
      // `application/shared/date` (single on-premise box, NFR-SEC-01).
      const perDayRows = await client.query<PerDayRow>(
        `WITH RECURSIVE day_windows AS (
            SELECT $1::bigint AS day_start
            UNION ALL
            SELECT day_start + 86400000 FROM day_windows WHERE day_start + 86400000 < $2::bigint
          ),
          range_tickets AS (
            SELECT created_at, called_at, served_at, completed_at
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            dw.day_start AS day_start,
            COUNT(rt.created_at)::int AS total_tickets,
            COALESCE(AVG(rt.called_at - rt.created_at) FILTER (WHERE rt.called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(rt.completed_at - rt.served_at) FILTER (WHERE rt.served_at IS NOT NULL AND rt.completed_at IS NOT NULL), 0)::bigint AS avg_service_ms,
            COUNT(*) FILTER (WHERE rt.served_at IS NOT NULL AND rt.completed_at IS NOT NULL)::int AS tickets_served
          FROM day_windows dw
          LEFT JOIN range_tickets rt ON rt.created_at >= dw.day_start AND rt.created_at < dw.day_start + 86400000
          GROUP BY dw.day_start
          ORDER BY dw.day_start`,
        [fromStart, toEnd],
      );
      const perDay: DailyPoint[] = perDayRows.rows.map((r) => ({
        date: toDateKey(Number(r.day_start)),
        totalTickets: Number(r.total_tickets),
        avgWaitTimeMs: Number(r.avg_wait_ms),
        avgServiceTimeMs: Number(r.avg_service_ms),
        ticketsServed: Number(r.tickets_served),
      }));

      // Per-category over the range (same shape as the daily per-category query,
      // widened to the range window).
      const perCat = await client.query<CategoryRow>(
        `WITH range_tickets AS (
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at, category_id
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            c.id AS category_id,
            c.code AS code,
            c.name AS category_name,
            COUNT(*)::int AS total_tickets,
            COALESCE(AVG(t.called_at - t.created_at) FILTER (WHERE t.called_at IS NOT NULL), 0)::bigint AS avg_wait_ms,
            COALESCE(AVG(t.completed_at - t.served_at) FILTER (WHERE t.served_at IS NOT NULL AND t.completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM range_tickets t JOIN categories c ON c.id = t.category_id
          GROUP BY c.id, c.code, c.name
          ORDER BY c.code ASC`,
        [fromStart, toEnd],
      );
      const perCategory: CategoryBreakdown[] = perCat.rows.map((r) => ({
        categoryId: r.category_id,
        code: r.code,
        categoryName: r.category_name,
        totalTickets: Number(r.total_tickets),
        avgWaitTimeMs: Number(r.avg_wait_ms),
        avgServiceTimeMs: Number(r.avg_service_ms),
      }));

      // Per-counter over the range (counters with no served tickets omitted —
      // the admin client backfills zero rows from the config).
      const perCounterRows = await client.query<RangeCounterRow>(
        `WITH range_tickets AS (
            SELECT created_at, called_at, served_at, completed_at, counter_id
            FROM tickets WHERE created_at >= $1 AND created_at < $2
            UNION ALL
            SELECT created_at, called_at, served_at, completed_at, counter_id
            FROM archived_tickets WHERE created_at >= $1 AND created_at < $2
          )
          SELECT
            counter_id,
            COUNT(*) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL)::int AS tickets_served,
            COALESCE(AVG(completed_at - served_at) FILTER (WHERE served_at IS NOT NULL AND completed_at IS NOT NULL), 0)::bigint AS avg_service_ms
          FROM range_tickets WHERE counter_id IS NOT NULL
          GROUP BY counter_id
          ORDER BY counter_id ASC`,
        [fromStart, toEnd],
      );
      const perCounter: CounterRangeBreakdown[] = perCounterRows.rows.map((r) => ({
        counterId: Number(r.counter_id),
        ticketsServed: Number(r.tickets_served),
        avgServiceTimeMs: Number(r.avg_service_ms),
      }));

      return new RangeQueueReport(
        Identifier.generate(),
        from,
        to,
        total,
        Number(totals.rows[0].avg_wait_ms),
        Number(totals.rows[0].avg_service_ms),
        perDay,
        perCategory,
        perCounter,
      );
    });
  }
}

interface RangeTotalsRow {
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
}
interface PerDayRow {
  day_start: string | number;
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
  tickets_served: string | number;
}
interface RangeCounterRow {
  counter_id: string | number;
  tickets_served: string | number;
  avg_service_ms: string | number;
}

interface TotalsRow {
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
}
interface CategoryRow {
  category_id: string;
  code: string;
  category_name: string;
  total_tickets: string | number;
  avg_wait_ms: string | number;
  avg_service_ms: string | number;
}
interface CounterRow {
  tickets_served: string | number;
  avg_service_ms: string | number;
  total: string | number;
}