import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import {
  GetCounterPerformanceUseCase,
  GetDailyReportUseCase,
  GetRangeReportUseCase,
  type DailyReportDto,
  type CounterPerformanceDto,
  type RangeReportDto,
  type DailyPointDto,
} from '../../application/reporting';
import { startOfLocalDayFromKey, toDateKey } from '../../application/shared/date';

/** `YYYY-MM-DD` — the only date shape the reporting read side accepts. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Epoch-ms in one day. */
const MS_PER_DAY = 86_400_000;

/** Empty daily report shape (no tickets for the date) — the analytics dashboard's zero state. */
const EMPTY_DAILY = (date: string): DailyReportDto => ({
  date,
  totalTickets: 0,
  avgWaitTimeMs: 0,
  avgServiceTimeMs: 0,
  perCategory: [],
});

/** Empty counter-performance shape (counter served nothing that day). */
const EMPTY_COUNTER = (counterId: number, date: string): CounterPerformanceDto => ({
  counterId,
  date,
  ticketsServed: 0,
  avgServiceTimeMs: 0,
});

/**
 * Empty range-report shape (no tickets in the range) — the analytics trend
 * view's zero state. Materializes a per-day zero series across `[from, to]` so
 * the trend chart renders a continuous axis even when nothing happened (an
 * empty day is still a day in the range, not a gap).
 */
const EMPTY_RANGE = (from: string, to: string): RangeReportDto => {
  const fromStart = startOfLocalDayFromKey(from);
  const toEnd = startOfLocalDayFromKey(to) + MS_PER_DAY;
  const perDay: DailyPointDto[] = [];
  for (let dayStart = fromStart; dayStart < toEnd; dayStart += MS_PER_DAY) {
    perDay.push({
      date: toDateKey(dayStart),
      totalTickets: 0,
      avgWaitTimeMs: 0,
      avgServiceTimeMs: 0,
      ticketsServed: 0,
    });
  }
  return {
    from,
    to,
    totalTickets: 0,
    avgWaitTimeMs: 0,
    avgServiceTimeMs: 0,
    perDay,
    perCategory: [],
    perCounter: [],
  };
};

/**
 * Reporting REST surface for the admin analytics dashboard (FR-ADM-03 / QUE-26).
 * The controller is the anti-corruption translation point: it turns the HTTP
 * query into a use-case command. `date` defaults to the store's local today
 * (single on-premise box, NFR-SEC-01) when omitted; the client normally sends
 * the picked date. The admin client constrains the date via an
 * `<input type="date">`, so an out-of-range or empty-result date yields the
 * zero-shape report DTO below (a clean dashboard zero state) rather than a 404;
 * the read side returns `null` when no tickets exist for the date.
 *
 * - `GET /api/reports/daily?date=YYYY-MM-DD` — total visitors, avg wait time,
 *   avg service time, per-category breakdown.
 * - `GET /api/reports/counters/:id?date=YYYY-MM-DD` — a single counter's served
 *   count + avg service time.
 * - `GET /api/reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD` — range totals, a
 *   per-day series for trend visualization, and per-category / per-counter
 *   aggregates over the range (FR-ADM-03 / QUE-44). The use case rejects
 *   `from > to` or a span over 90 days with `InvalidArgumentException` (→ 400).
 */
@Controller('api/reports')
export class ReportingController {
  constructor(
    private readonly getDailyReport: GetDailyReportUseCase,
    private readonly getCounterPerformance: GetCounterPerformanceUseCase,
    private readonly getRangeReport: GetRangeReportUseCase,
  ) {}

  @Get('daily')
  async daily(@Query('date') date: string): Promise<DailyReportDto> {
    const resolved = this.resolveDate(date);
    return (await this.getDailyReport.execute({ date: resolved })) ?? EMPTY_DAILY(resolved);
  }

  @Get('range')
  async range(
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<RangeReportDto> {
    // `from`/`to` default to the store's local today when omitted (a single-day
    // range for "today"). Both are validated as YYYY-MM-DD here; the use case
    // additionally enforces `from <= to` and the 90-day max span.
    const resolvedFrom = this.resolveDate(from);
    const resolvedTo = this.resolveDate(to);
    return (
      (await this.getRangeReport.execute({ from: resolvedFrom, to: resolvedTo })) ??
      EMPTY_RANGE(resolvedFrom, resolvedTo)
    );
  }

  @Get('counters/:id')
  async counter(
    @Query('date') date: string,
    // `id` is the counter id path param (integer). Nest injects it as a string;
    // validate at the boundary so a malformed id yields 400 (not a 500 from a
    // NaN reaching the SQL layer).
    @Param('id') id: string,
  ): Promise<CounterPerformanceDto> {
    const resolved = this.resolveDate(date);
    const counterId = Number(id);
    if (!Number.isInteger(counterId) || counterId < 1) {
      throw new BadRequestException('Counter id must be a positive integer');
    }
    return (
      (await this.getCounterPerformance.execute({ counterId, date: resolved })) ??
      EMPTY_COUNTER(counterId, resolved)
    );
  }

  /**
   * Resolves the `?date=` query param: defaults to the store's local today when
   * omitted/blank, otherwise validates the `YYYY-MM-DD` shape so a malformed
   * date yields 400 (not a 500 from a `NaN` epoch reaching the SQL layer).
   */
  private resolveDate(date: string | undefined): string {
    const trimmed = date?.trim();
    if (!trimmed) return toDateKey(Date.now());
    if (!DATE_RE.test(trimmed)) {
      throw new BadRequestException('date must be in YYYY-MM-DD format');
    }
    return trimmed;
  }
}