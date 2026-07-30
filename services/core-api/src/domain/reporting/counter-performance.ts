import { Entity } from '../shared/entity';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';

/**
 * Read model for a single counter's performance on a given day (FR-ADM-03 /
 * QUE-26). Used by the analytics/export module.
 */
export class CounterPerformance extends Entity {
  constructor(
    id: Identifier,
    public readonly counterId: number,
    public readonly date: string,
    public readonly ticketsServed: number,
    public readonly avgServiceTimeMs: number,
  ) {
    super(id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new InvalidValueObjectException(`date must be YYYY-MM-DD, got '${date}'`);
    }
    if (!Number.isInteger(counterId) || counterId < 1) {
      throw new InvalidValueObjectException(`invalid counter id '${counterId}'`);
    }
    if (ticketsServed < 0 || avgServiceTimeMs < 0) {
      throw new InvalidValueObjectException('performance metrics must be non-negative');
    }
  }
}