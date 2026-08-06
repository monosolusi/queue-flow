import type { IReportQueryPort } from '../../domain/reporting';
import type {
  RangeQueueReport,
  DailyPoint,
  CounterRangeBreakdown,
} from '../../domain/reporting';
import type { CategoryBreakdownDto } from './get-daily-report.use-case';
import { InvalidArgumentException } from '../../domain/shared/errors';
import { startOfLocalDayFromKey } from '../shared/date';

/**
 * Maximum span (inclusive, in local days) a range report may cover (FR-ADM-03 /
 * QUE-44). Bounds the per-day series and the underlying scan so a runaway range
 * cannot fan out an unbounded recursive day-window or an expensive full-table
 * aggregate. Enforced as a use-case-level business guardrail
 * (`InvalidArgumentException`, → 400) — NOT a {@link RangeQueueReport} domain
 * invariant — because the cap is a business policy on the *command*, not a
 * structural property of the read model (mirrors the transaction-log retention
 * floor in `CleanupTransactionLogUseCase`).
 */
export const MAX_RANGE_DAYS = 90;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Command for the range-report read (FR-ADM-03 / QUE-44). `from` and `to` are
 * the store's local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01); the range
 * is inclusive of both days. The admin analytics client picks the bounds
 * (default: the last 7 days).
 */
export interface GetRangeReportCommand {
  readonly from: string;
  readonly to: string;
}

/** Transport-agnostic projection of {@link DailyPoint}. */
export interface DailyPointDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly ticketsServed: number;
}

/** Transport-agnostic projection of {@link CounterRangeBreakdown}. */
export interface CounterRangeBreakdownDto {
  readonly counterId: number;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/** Transport-agnostic projection of {@link RangeQueueReport}. */
export interface RangeReportDto {
  readonly from: string;
  readonly to: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perDay: readonly DailyPointDto[];
  readonly perCategory: readonly CategoryBreakdownDto[];
  readonly perCounter: readonly CounterRangeBreakdownDto[];
}

/**
 * The inclusive local-day count spanned by `[from, to]` (same-day = 1, a
 * 7-day range = 7). Pure; used by the use case to enforce
 * {@link MAX_RANGE_DAYS} and by the controller to materialize the empty-range
 * per-day zero series.
 */
export function daySpan(from: string, to: string): number {
  return Math.round(
    (startOfLocalDayFromKey(to) - startOfLocalDayFromKey(from)) / MS_PER_DAY,
  ) + 1;
}

/**
 * Projects a {@link RangeQueueReport} into a {@link RangeReportDto}. The single
 * place that maps the read model to the transport DTO — use cases never return
 * the domain read model itself (DIP / no domain leakage), mirroring
 * {@link projectDailyReport}.
 */
export function projectRangeReport(report: RangeQueueReport): RangeReportDto {
  return {
    from: report.from,
    to: report.to,
    totalTickets: report.totalTickets,
    avgWaitTimeMs: report.avgWaitTimeMs,
    avgServiceTimeMs: report.avgServiceTimeMs,
    perDay: report.perDay.map((p) => ({
      date: p.date,
      totalTickets: p.totalTickets,
      avgWaitTimeMs: p.avgWaitTimeMs,
      avgServiceTimeMs: p.avgServiceTimeMs,
      ticketsServed: p.ticketsServed,
    })),
    perCategory: report.perCategory.map((c) => ({
      categoryId: c.categoryId,
      code: c.code,
      categoryName: c.categoryName,
      totalTickets: c.totalTickets,
      avgWaitTimeMs: c.avgWaitTimeMs,
      avgServiceTimeMs: c.avgServiceTimeMs,
    })),
    perCounter: report.perCounter.map((c) => ({
      counterId: c.counterId,
      ticketsServed: c.ticketsServed,
      avgServiceTimeMs: c.avgServiceTimeMs,
    })),
  };
}

/**
 * Read-side use case: returns the queue analytics report aggregated over a
 * `[from, to]` local-day range (FR-ADM-03 / QUE-44). Range totals + a per-day
 * series (for trend visualization) + per-category and per-counter aggregates
 * over the range. Source data is the same `tickets` UNION `archived_tickets`
 * scan as the daily report, widened to the range window.
 *
 * Command guardrails (→ `InvalidArgumentException` → 400): `from`/`to` must be
 * `YYYY-MM-DD`, `from <= to`, and the span must not exceed
 * {@link MAX_RANGE_DAYS}. They fire before any read so an illegal range burns
 * no rows (NFR-REL-02 pattern).
 *
 * Depends only on a port (DIP) — no ORM, HTTP framework, or I/O library — so
 * the application layer stays framework-free (NFR-MNT-01). Returns `null` when
 * no tickets exist in the range (the controller maps that to the empty-range
 * DTO shape with a per-day zero series).
 */
export class GetRangeReportUseCase {
  constructor(private readonly reportQuery: IReportQueryPort) {}

  async execute(command: GetRangeReportCommand): Promise<RangeReportDto | null> {
    const { from, to } = command;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new InvalidArgumentException(
        `range bounds must be YYYY-MM-DD, got from='${from}' to='${to}'`,
      );
    }
    if (from > to) {
      throw new InvalidArgumentException(`range 'from' must be <= 'to'`);
    }
    const span = daySpan(from, to);
    if (span > MAX_RANGE_DAYS) {
      throw new InvalidArgumentException(
        `range cannot exceed ${MAX_RANGE_DAYS} days (got ${span})`,
      );
    }
    const report = await this.reportQuery.rangeReport(from, to);
    return report ? projectRangeReport(report) : null;
  }
}