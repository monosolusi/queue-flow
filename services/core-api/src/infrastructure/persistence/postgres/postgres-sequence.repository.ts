import type { Pool } from 'pg';
import { type ISequenceRepository, TicketNumber } from '../../../domain/queue';
import { withDbClient } from './transaction-context';

/**
 * PostgreSQL implementation of {@link ISequenceRepository} (QUE-30 / NFR-REL-02).
 * `nextTicketNumber` is an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * on the `(category_id, date)` row. When called inside a {@link
 * PostgresTransactionManager} transaction it enlists on the ambient client, so
 * the increment commits (or rolls back) together with the ticket insert — a
 * power cut between reserve and insert leaves neither a duplicate nor a gap.
 */
export class PostgresSequenceRepository implements ISequenceRepository {
  constructor(private readonly pool: Pool) {}

  async nextTicketNumber(
    categoryId: string,
    categoryCode: string,
    date: string,
  ): Promise<TicketNumber> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<{ value: string }>(
        `INSERT INTO sequence_counters (category_id, date, value) VALUES ($1, $2, 1)
         ON CONFLICT (category_id, date)
         DO UPDATE SET value = sequence_counters.value + 1
         RETURNING value`,
        [categoryId, date],
      );
      return TicketNumber.of(categoryCode, Number(rows[0].value));
    });
  }

  async currentSequence(categoryId: string, date: string): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<{ value: number }>(
        'SELECT value FROM sequence_counters WHERE category_id = $1 AND date = $2',
        [categoryId, date],
      );
      return rows.length ? Number(rows[0].value) : 0;
    });
  }

  async resetDaily(date: string, resetTo = 1): Promise<void> {
    // Mirror the in-memory semantics: the counter is set to resetTo - 1 so the
    // next `nextTicketNumber` mints exactly `resetTo`.
    await withDbClient(this.pool, async (client) => {
      await client.query('UPDATE sequence_counters SET value = $1 WHERE date = $2', [
        resetTo - 1,
        date,
      ]);
    });
  }
}