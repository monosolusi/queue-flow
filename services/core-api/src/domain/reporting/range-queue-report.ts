import { Entity } from '../shared/entity';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';
import type { CategoryBreakdown } from './daily-queue-report';

/**
 * One day's aggregate within a range report. `date` is the local-day key
 * (`YYYY-MM-DD`, single on-premise box — NFR-SEC-01). Days with no tickets
 * surface as zero-point rows so the trend visualization can render a
 * continuous axis across the range.
 */
export interface DailyPoint {
  readonly date: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
  readonly ticketsServed: number;
}

/**
 * A single counter's aggregate over the whole range (FR-ADM-03 / QUE-44).
 * Mirrors {@link CounterPerformance} but drops the per-day `date` (the range
 * bounds live on the enclosing {@link RangeQueueReport}).
 */
export interface CounterRangeBreakdown {
  readonly counterId: number;
  readonly ticketsServed: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Read model for the range analytics report (FR-ADM-03 / QUE-44). A multi-day
 * extension of {@link DailyQueueReport}: range totals + a per-day series for
 * trend visualization + per-category and per-counter aggregates over the
 * range. Reporting read models are immutable snapshots, not aggregate roots,
 * but carry invariants that protect their internal consistency.
 *
 * The `from <= to` and `YYYY-MM-DD` invariants live here (value-object-level,
 * malformed-value → `InvalidValueObjectException` → 400). The 90-day max-span
 * business guardrail is a use-case-level rule (`InvalidArgumentException`),
 * NOT a domain invariant — see `GetRangeReportUseCase`.
 */
export class RangeQueueReport extends Entity {
  constructor(
    id: Identifier,
    public readonly from: string,
    public readonly to: string,
    public readonly totalTickets: number,
    public readonly avgWaitTimeMs: number,
    public readonly avgServiceTimeMs: number,
    public readonly perDay: readonly DailyPoint[],
    public readonly perCategory: readonly CategoryBreakdown[],
    public readonly perCounter: readonly CounterRangeBreakdown[],
  ) {
    super(id);
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new InvalidValueObjectException(
        `range bounds must be YYYY-MM-DD, got from='${from}' to='${to}'`,
      );
    }
    if (from > to) {
      throw new InvalidValueObjectException(`range 'from' must be <= 'to'`);
    }
    if (totalTickets < 0 || avgWaitTimeMs < 0 || avgServiceTimeMs < 0) {
      throw new InvalidValueObjectException('range metrics must be non-negative');
    }
    for (const p of perDay) {
      if (!DATE_RE.test(p.date)) {
        throw new InvalidValueObjectException(`per-day date must be YYYY-MM-DD, got '${p.date}'`);
      }
      if (
        p.totalTickets < 0 ||
        p.avgWaitTimeMs < 0 ||
        p.avgServiceTimeMs < 0 ||
        p.ticketsServed < 0
      ) {
        throw new InvalidValueObjectException('per-day metrics must be non-negative');
      }
    }
    for (const c of perCounter) {
      if (!Number.isInteger(c.counterId) || c.counterId < 1) {
        throw new InvalidValueObjectException(`invalid counter id '${c.counterId}'`);
      }
      if (c.ticketsServed < 0 || c.avgServiceTimeMs < 0) {
        throw new InvalidValueObjectException('per-counter metrics must be non-negative');
      }
    }
  }
}