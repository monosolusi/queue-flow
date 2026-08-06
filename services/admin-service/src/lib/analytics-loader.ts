import type { IAdminApi } from '../api/admin-api';
import type { AuditLogEntryDto, RangeReportDto } from '../api/types';

/**
 * Range analytics-overview loader (FR-ADM-03 / QUE-44). Pure + framework-free:
 * it consumes only the read-side slice of {@link IAdminApi} (the range report +
 * the audit trail + config-to-enumerate-counters) and never touches
 * caller/kiosk/tv DTOs (ISP). The page owns the view-state machine + the
 * from/to inputs; this module owns the load.
 *
 * Replaces the former single-day `loadDailyOverview` — Analitik is now a
 * multi-day range view (the daily view was duplicated on the Dashboard; QUE-44
 * splits live status from historical analytics, so the daily loader is gone).
 */

/** One counter's range-aggregated performance (name-joined + zero-backfilled). */
export interface RangeCounterRow {
  readonly counterId: number;
  readonly counterName: string;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/** The fully-loaded range analytics view for `[from, to]`. */
export interface RangeOverviewData {
  readonly from: string;
  readonly to: string;
  readonly report: RangeReportDto;
  /** Counters in config order, zero-backfilled from the routing rules. */
  readonly counters: readonly RangeCounterRow[];
  readonly audit: readonly AuditLogEntryDto[];
  /** `counterId → display name`, reused by the xlsx export's Performa Counter sheet. */
  readonly counterNameById: ReadonlyMap<number, string>;
}

/**
 * Loads the full range analytics view: the range report, the audit trail, and
 * per-counter range performance (counters enumerated from the config's routing
 * rules, zero-backfilled from the report's `perCounter` slice so a counter that
 * served nothing in the range still appears as a `0` row). The config read is
 * needed only to label counters by name + enumerate the full counter set; if it
 * fails the whole load fails (no partial view) — analytics is read-only, so a
 * transient error is preferable to silently dropping a section.
 */
export async function loadRangeOverview(
  api: IAdminApi,
  from: string,
  to: string,
): Promise<RangeOverviewData> {
  const [report, config, audit] = await Promise.all([
    api.getRangeReport(from, to),
    api.getSystemConfig(),
    api.getAuditLog(),
  ]);
  const counterNameById = new Map<number, string>(
    config.routingRules.map((r) => [r.counterId, r.counterName]),
  );
  const byId = new Map(report.perCounter.map((c) => [c.counterId, c]));
  const counters: RangeCounterRow[] = config.routingRules.map((r) => {
    const perf = byId.get(r.counterId);
    return {
      counterId: r.counterId,
      counterName: r.counterName,
      ticketsServed: perf?.ticketsServed ?? 0,
      avgServiceTimeMs: perf?.avgServiceTimeMs ?? 0,
    };
  });
  return { from, to, report, counters, audit, counterNameById };
}