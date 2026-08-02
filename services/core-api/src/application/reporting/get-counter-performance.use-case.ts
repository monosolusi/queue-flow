import type { IReportQueryPort } from '../../domain/reporting';
import type { CounterPerformance } from '../../domain/reporting';

/**
 * Command for the counter-performance read (FR-ADM-03 / QUE-26). `counterId` is
 * the integer counter identifier; `date` is the store's local `YYYY-MM-DD`.
 */
export interface GetCounterPerformanceCommand {
  readonly counterId: number;
  readonly date: string;
}

/** Transport-agnostic projection of {@link CounterPerformance}. */
export interface CounterPerformanceDto {
  readonly counterId: number;
  readonly date: string;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Projects a {@link CounterPerformance} read model into a
 * {@link CounterPerformanceDto}. The single mapping point — use cases never
 * return the domain read model itself (DIP / no domain leakage), mirroring the
 * other read-side use cases.
 */
export function projectCounterPerformance(report: CounterPerformance): CounterPerformanceDto {
  return {
    counterId: report.counterId,
    date: report.date,
    ticketsServed: report.ticketsServed,
    avgServiceTimeMs: report.avgServiceTimeMs,
  };
}

/**
 * Read-side use case: returns a single counter's performance for a given local
 * date (FR-ADM-03 / QUE-26) — how many tickets the counter completed and the
 * average service time. Source data is the same `tickets` UNION
 * `archived_tickets` window, filtered by `counter_id`.
 *
 * Depends only on a port (DIP) — framework-free application layer (NFR-MNT-01).
 * Returns `null` when the counter served nothing that day (the controller maps
 * that to the empty-performance DTO shape).
 */
export class GetCounterPerformanceUseCase {
  constructor(private readonly reportQuery: IReportQueryPort) {}

  async execute(command: GetCounterPerformanceCommand): Promise<CounterPerformanceDto | null> {
    const report = await this.reportQuery.counterPerformance(command.counterId, command.date);
    return report ? projectCounterPerformance(report) : null;
  }
}