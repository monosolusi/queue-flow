import type { IReportQueryPort } from '../../domain/reporting';
import type { DailyQueueReport, CategoryBreakdown } from '../../domain/reporting';

/**
 * Command for the daily-report read (FR-ADM-03 / QUE-26). `date` is the store's
 * local `YYYY-MM-DD` (single on-premise box, NFR-SEC-01) — the same date key the
 * daily-reset engine uses. The admin client picks the date.
 */
export interface GetDailyReportCommand {
  readonly date: string;
}

/** Transport-agnostic projection of {@link CategoryBreakdown}. */
export interface CategoryBreakdownDto {
  readonly categoryId: string;
  readonly code: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
}

/** Transport-agnostic projection of {@link DailyQueueReport}. */
export interface DailyReportDto {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly perCategory: readonly CategoryBreakdownDto[];
}

/**
 * Projects a {@link DailyQueueReport} into a {@link DailyReportDto}. The single
 * place that knows how the read model maps to the transport DTO — use cases
 * never return the domain read model itself (DIP / no domain leakage), mirroring
 * {@link ListCategoriesUseCase.projectCategory}.
 */
export function projectDailyReport(report: DailyQueueReport): DailyReportDto {
  return {
    date: report.date,
    totalTickets: report.totalTickets,
    avgWaitTimeMs: report.avgWaitTimeMs,
    avgServiceTimeMs: report.avgServiceTimeMs,
    perCategory: report.perCategory.map((c) => ({
      categoryId: c.categoryId,
      code: c.code,
      totalTickets: c.totalTickets,
      avgWaitTimeMs: c.avgWaitTimeMs,
      avgServiceTimeMs: c.avgServiceTimeMs,
    })),
  };
}

/**
 * Read-side use case: returns the daily queue analytics report for a given
 * local date (FR-ADM-03 / QUE-26). The report aggregates every ticket created
 * that day (active `tickets` UNION `archived_tickets` for a past day) into
 * totals + avg wait time + avg service time, broken down per category.
 *
 * Depends only on a port (DIP) — no ORM, HTTP framework, or I/O library — so the
 * application layer stays framework-free (NFR-MNT-01). Concrete query wiring
 * (in-memory + PostgreSQL CQRS read side) is supplied by the persistence
 * modules. Returns `null` when no tickets exist for the date (the controller
 * maps that to the empty-report DTO shape).
 */
export class GetDailyReportUseCase {
  constructor(private readonly reportQuery: IReportQueryPort) {}

  async execute(command: GetDailyReportCommand): Promise<DailyReportDto | null> {
    const report = await this.reportQuery.dailyReport(command.date);
    return report ? projectDailyReport(report) : null;
  }
}