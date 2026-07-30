import { Entity } from '../shared/entity';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';

export interface CategoryBreakdown {
  readonly categoryId: string;
  readonly code: string;
  readonly totalTickets: number;
  readonly avgWaitTimeMs: number;
  readonly avgServiceTimeMs: number;
}

/**
 * Read model for the daily analytics report (FR-ADM-03 / QUE-26). Reporting
 * read models are immutable snapshots; they are not aggregate roots but carry
 * invariants that protect their internal consistency.
 */
export class DailyQueueReport extends Entity {
  constructor(
    id: Identifier,
    public readonly date: string,
    public readonly totalTickets: number,
    public readonly avgWaitTimeMs: number,
    public readonly avgServiceTimeMs: number,
    public readonly perCategory: readonly CategoryBreakdown[],
  ) {
    super(id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new InvalidValueObjectException(`date must be YYYY-MM-DD, got '${date}'`);
    }
    if (totalTickets < 0 || avgWaitTimeMs < 0 || avgServiceTimeMs < 0) {
      throw new InvalidValueObjectException('report metrics must be non-negative');
    }
  }
}