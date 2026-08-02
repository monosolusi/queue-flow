import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  GetCounterPerformanceUseCase,
  GetDailyReportUseCase,
  type DailyReportDto,
  type CounterPerformanceDto,
} from '../../application/reporting';
import { toDateKey } from '../../application/shared/date';

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
 */
@Controller('api/reports')
export class ReportingController {
  constructor(
    private readonly getDailyReport: GetDailyReportUseCase,
    private readonly getCounterPerformance: GetCounterPerformanceUseCase,
  ) {}

  @Get('daily')
  async daily(@Query('date') date: string): Promise<DailyReportDto> {
    const resolved = date?.trim() ? date.trim() : toDateKey(Date.now());
    return (await this.getDailyReport.execute({ date: resolved })) ?? EMPTY_DAILY(resolved);
  }

  @Get('counters/:id')
  async counter(
    @Query('date') date: string,
    // `id` is the counter id path param (integer). Nest injects it as a string;
    // a non-numeric id is a client error → coerce, the read model validates
    // `counterId ≥ 1` and throws `InvalidValueObjectException` (→ 400).
    @Param('id') id: string,
  ): Promise<CounterPerformanceDto> {
    const resolved = date?.trim() ? date.trim() : toDateKey(Date.now());
    const counterId = Number(id);
    return (
      (await this.getCounterPerformance.execute({ counterId, date: resolved })) ??
      EMPTY_COUNTER(counterId, resolved)
    );
  }
}