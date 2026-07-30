import type { DailyQueueReport } from '../daily-queue-report';
import type { CounterPerformance } from '../counter-performance';

/**
 * Query port for the Reporting bounded context (CQRS read side). Use cases and
 * the admin analytics module depend on this abstraction, not on a concrete
 * query implementation.
 *
 * Note: the in-memory implementation and contract test for this port are
 * intentionally deferred to QUE-26 (daily analytics & local export reporting),
 * which owns the Reporting read models end-to-end. Defining the port here lets
 * downstream use cases depend on the abstraction now.
 */
export interface IReportQueryPort {
  dailyReport(date: string): Promise<DailyQueueReport | null>;
  counterPerformance(counterId: number, date: string): Promise<CounterPerformance | null>;
}