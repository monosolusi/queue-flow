import type { DailyQueueReport } from '../daily-queue-report';
import type { CounterPerformance } from '../counter-performance';
import type { RangeQueueReport } from '../range-queue-report';

/**
 * NestJS DI token for {@link IReportQueryPort}. Interface ports are erased at
 * runtime, so NestJS can't resolve them by type metadata — each port carries a
 * co-located Symbol token and is bound with `{ provide: <token>, … }` in the
 * persistence profile modules (mirrors `AUDIT_LOG_REPOSITORY` /
 * `QUEUE_REPOSITORY`).
 */
export const REPORT_QUERY_PORT = Symbol('REPORT_QUERY_PORT');

/**
 * Query port for the Reporting bounded context (CQRS read side). Use cases and
 * the admin analytics module depend on this abstraction, not on a concrete
 * query implementation.
 *
 * The implementations (in-memory + PostgreSQL) and the audit-trail read surface
 * are delivered by QUE-26 (daily analytics & local export reporting), which
 * owns the Reporting read models end-to-end. Defining the port here lets
 * downstream use cases depend on the abstraction now.
 */
export interface IReportQueryPort {
  dailyReport(date: string): Promise<DailyQueueReport | null>;
  counterPerformance(counterId: number, date: string): Promise<CounterPerformance | null>;
  /**
   * Aggregates queue metrics over a `[from, to]` local-day range (inclusive of
   * both days). Returns range totals, a per-day series (zero-point rows for
   * days with no tickets), per-category aggregates, and per-counter aggregates
   * over the range (FR-ADM-03 / QUE-44). Returns `null` when no tickets exist
   * in the range. The 90-day max-span guardrail is enforced by the use case,
   * not here.
   */
  rangeReport(from: string, to: string): Promise<RangeQueueReport | null>;
}