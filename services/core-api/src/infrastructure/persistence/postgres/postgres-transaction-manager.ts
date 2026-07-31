import type { Pool } from 'pg';
import type { ITransactionManager } from '../../../domain/shared';
import { txStorage } from './transaction-context';

/**
 * PostgreSQL implementation of the {@link ITransactionManager} port (QUE-30 /
 * NFR-REL-02). Checks a client out of the pool, issues `BEGIN`, runs `work` with
 * the client published to the ambient {@link txStorage} so every enlisting
 * repository reuses the same connection, then `COMMIT`s on success or
 * `ROLLBACK`s on throw. The client is always released.
 *
 * With PostgreSQL's default WAL (`fsync=on`, `synchronous_commit=on`), every
 * committed write survives a power cut — so reserving a sequence number and
 * inserting the ticket inside one `runInTransaction` either both survive or
 * both roll back: no duplicate numbers, no gaps.
 *
 * Infrastructure only — depends on `pg` and the domain port (the port has no
 * `pg` type, so the dependency direction stays infrastructure → domain).
 */
export class PostgresTransactionManager implements ITransactionManager {
  constructor(private readonly pool: Pool) {}

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, work);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ROLLBACK failure is secondary to the original error; swallow so the
        // original cause propagates unchanged.
      }
      throw err;
    } finally {
      client.release();
    }
  }
}