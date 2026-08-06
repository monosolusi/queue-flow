import { Identifier } from '../../../domain/shared/identifier';
import type { ICategoryRepository } from '../../../domain/queue';
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
import { InMemoryQueueRepository } from './in-memory-queue.repository';

/** The subset of a ticket the metrics computation reads (keeps the helper typed). */
interface TicketMetrics {
  readonly categoryId: string;
  readonly createdAt: number;
  readonly calledAt: number | null;
  readonly servedAt: number | null;
  readonly completedAt: number | null;
  readonly counterId: number | null;
}

/** Epoch-ms in one day. */
const MS_PER_DAY = 86_400_000;

/** Arithmetic mean of `values`, rounded to the nearest ms; `0` when empty. */
function avgMs(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return Math.round(sum / values.length);
}

/**
 * In-memory implementation of {@link IReportQueryPort} (QUE-26, CQRS read side).
 * Computes daily-report + counter-performance metrics by scanning the same
 * in-memory ticket store the live queue uses (active tickets via
 * {@link InMemoryQueueRepository.allActive} + archived tickets via
 * `archivedTickets`), filtered to the requested local day. Category codes are
 * resolved through {@link ICategoryRepository}.
 *
 * Dev/test only — not an LSP substitute for the PostgreSQL read side (which
 * computes the same metrics in SQL). Depends on the concrete
 * {@link InMemoryQueueRepository} (infrastructure → infrastructure, allowed;
 * the write-side port stays free of list-all read methods). The report repo is
 * wired with the same singleton queue instance the rest of the in-memory
 * profile shares, so it reads live data.
 */
export class InMemoryReportQueryRepository implements IReportQueryPort {
  constructor(
    private readonly queue: InMemoryQueueRepository,
    private readonly categories: ICategoryRepository,
  ) {}

  async dailyReport(date: string): Promise<DailyQueueReport | null> {
    const dayStart = startOfLocalDayFromKey(date);
    const dayEnd = dayStart + MS_PER_DAY;
    const inDay = [...this.queue.allActive(), ...this.queue.archivedTickets()].filter(
      (t) => t.createdAt >= dayStart && t.createdAt < dayEnd,
    );
    if (inDay.length === 0) return null;

    const waits = inDay.filter((t) => t.calledAt !== null).map((t) => t.calledAt! - t.createdAt);
    const services = inDay
      .filter((t) => t.servedAt !== null && t.completedAt !== null)
      .map((t) => t.completedAt! - t.servedAt!);

    const perCategory = await this.breakdownByCategory(inDay);
    return new DailyQueueReport(
      Identifier.generate(),
      date,
      inDay.length,
      avgMs(waits),
      avgMs(services),
      perCategory,
    );
  }

  async counterPerformance(counterId: number, date: string): Promise<CounterPerformance | null> {
    const dayStart = startOfLocalDayFromKey(date);
    const dayEnd = dayStart + MS_PER_DAY;
    const inDay = [...this.queue.allActive(), ...this.queue.archivedTickets()].filter(
      (t) =>
        t.counterId === counterId && t.createdAt >= dayStart && t.createdAt < dayEnd,
    );
    if (inDay.length === 0) return null;

    const served = inDay.filter((t) => t.completedAt !== null && t.servedAt !== null);
    const services = served.map((t) => t.completedAt! - t.servedAt!);
    return new CounterPerformance(
      Identifier.generate(),
      counterId,
      date,
      served.length,
      avgMs(services),
    );
  }

  async rangeReport(from: string, to: string): Promise<RangeQueueReport | null> {
    const fromStart = startOfLocalDayFromKey(from);
    const toEnd = startOfLocalDayFromKey(to) + MS_PER_DAY;
    const inRange = [...this.queue.allActive(), ...this.queue.archivedTickets()].filter(
      (t) => t.createdAt >= fromStart && t.createdAt < toEnd,
    );
    if (inRange.length === 0) return null;

    // Per-day series — emit a zero-point row for every day in the range so the
    // trend visualization renders a continuous axis (an empty day is still a
    // day in the range, not a gap).
    const perDay: DailyPoint[] = [];
    for (let dayStart = fromStart; dayStart < toEnd; dayStart += MS_PER_DAY) {
      const dayEnd = dayStart + MS_PER_DAY;
      const inDay = inRange.filter((t) => t.createdAt >= dayStart && t.createdAt < dayEnd);
      const waits = inDay
        .filter((t) => t.calledAt !== null)
        .map((t) => t.calledAt! - t.createdAt);
      const services = inDay
        .filter((t) => t.servedAt !== null && t.completedAt !== null)
        .map((t) => t.completedAt! - t.servedAt!);
      const served = inDay.filter((t) => t.servedAt !== null && t.completedAt !== null);
      perDay.push({
        date: toDateKey(dayStart),
        totalTickets: inDay.length,
        avgWaitTimeMs: avgMs(waits),
        avgServiceTimeMs: avgMs(services),
        ticketsServed: served.length,
      });
    }

    // Range totals.
    const waits = inRange
      .filter((t) => t.calledAt !== null)
      .map((t) => t.calledAt! - t.createdAt);
    const services = inRange
      .filter((t) => t.servedAt !== null && t.completedAt !== null)
      .map((t) => t.completedAt! - t.servedAt!);

    const perCategory = await this.breakdownByCategory(inRange);

    // Per-counter aggregates over the range (counters with no served tickets
    // are omitted — the admin client backfills zero rows from the config).
    const byCounter = new Map<number, TicketMetrics[]>();
    for (const t of inRange) {
      if (t.counterId === null) continue;
      const list = byCounter.get(t.counterId) ?? [];
      list.push(t);
      byCounter.set(t.counterId, list);
    }
    const perCounter: CounterRangeBreakdown[] = [];
    for (const [counterId, list] of byCounter) {
      const served = list.filter((t) => t.servedAt !== null && t.completedAt !== null);
      const svc = served.map((t) => t.completedAt! - t.servedAt!);
      perCounter.push({
        counterId,
        ticketsServed: served.length,
        avgServiceTimeMs: avgMs(svc),
      });
    }
    perCounter.sort((a, b) => a.counterId - b.counterId);

    return new RangeQueueReport(
      Identifier.generate(),
      from,
      to,
      inRange.length,
      avgMs(waits),
      avgMs(services),
      perDay,
      perCategory,
      perCounter,
    );
  }

  /** Groups `tickets` by category and computes the per-category breakdown. */
  private async breakdownByCategory(
    tickets: readonly TicketMetrics[],
  ): Promise<readonly CategoryBreakdown[]> {
    const allCats = await this.categories.getAll();
    const codeById = new Map(allCats.map((c) => [c.id.value, c.code]));

    const groups = new Map<string, TicketMetrics[]>();
    for (const t of tickets) {
      const list = groups.get(t.categoryId) ?? [];
      list.push(t);
      groups.set(t.categoryId, list);
    }

    const result: CategoryBreakdown[] = [];
    for (const [categoryId, list] of groups) {
      const waits = list.filter((t) => t.calledAt !== null).map((t) => t.calledAt! - t.createdAt);
      const services = list
        .filter((t) => t.servedAt !== null && t.completedAt !== null)
        .map((t) => t.completedAt! - t.servedAt!);
      result.push({
        categoryId,
        code: codeById.get(categoryId) ?? '?',
        totalTickets: list.length,
        avgWaitTimeMs: avgMs(waits),
        avgServiceTimeMs: avgMs(services),
      });
    }
    // Stable order by code so the report table does not reshuffle between reads.
    return result.sort((a, b) => a.code.localeCompare(b.code));
  }
}