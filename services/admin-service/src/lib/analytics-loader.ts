import type { IAdminApi } from '../api/admin-api';
import type {
  AuditLogEntryDto,
  CounterPerformanceDto,
  DailyReportDto,
} from '../api/types';

/**
 * Shared analytics-overview loader (FR-ADM-03 / QUE-26) — extracted from
 * `AnalyticsPage` so the new `DashboardPage` can reuse the exact same read
 * (DRY) without the page owning a second copy of the orchestration. Pure +
 * framework-free: it consumes only the read-side slice of {@link IAdminApi}
 * (reporting + audit + config-to-enumerate-counters) and never touches
 * caller/kiosk/tv DTOs (ISP). The page owns the view-state machine; this module
 * owns the load.
 */

/** A counter row in the performance table (the routing-rule display name + its read). */
export interface CounterRow {
  readonly counterId: number;
  readonly counterName: string;
  readonly perf: CounterPerformanceDto;
}

/** The fully-loaded analytics view for one date. */
export interface OverviewData {
  readonly date: string;
  readonly report: DailyReportDto;
  readonly counters: readonly CounterRow[];
  readonly audit: readonly AuditLogEntryDto[];
}

/**
 * Loads the full analytics view for one date: the daily report, the audit trail,
 * and per-counter performance (counters enumerated from the config's routing
 * rules). The config read is needed only to label counters by name; if it fails
 * the whole load fails (no partial view) — the dashboard is read-only, so a
 * transient error is preferable to silently dropping a section.
 */
export async function loadDailyOverview(api: IAdminApi, date: string): Promise<OverviewData> {
  const [report, config, audit] = await Promise.all([
    api.getDailyReport(date),
    api.getSystemConfig(),
    api.getAuditLog(),
  ]);
  const counters: CounterRow[] = await Promise.all(
    config.routingRules.map((r) =>
      api.getCounterPerformance(r.counterId, date).then((perf) => ({
        counterId: r.counterId,
        counterName: r.counterName,
        perf,
      })),
    ),
  );
  return { date, report, counters, audit };
}

/**
 * The "no activity for this date" predicate, shared by the dashboard + the
 * analytics page so the two views can't drift on what "an empty day" means
 * (DRY). A day is empty when no tickets were issued, nothing was served, and
 * the audit trail is quiet — i.e. there is nothing to chart or tabulate.
 */
export function isOverviewEmpty(data: OverviewData): boolean {
  return (
    data.report.totalTickets === 0 &&
    data.audit.length === 0 &&
    data.counters.every((c) => c.perf.ticketsServed === 0)
  );
}