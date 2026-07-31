import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

/**
 * Ambient storage for the current transaction's `pg` client (QUE-30 / NFR-REL-02).
 *
 * The {@link PostgresTransactionManager} runs `work` inside `BEGIN`/`COMMIT`,
 * storing the checkout client here for the duration of the transaction.
 * Repository methods that wish to enlist read the ambient client via {@link
 * withDbClient} — if a transaction is active they reuse its connection (so every
 * write lands in the same tx and commits/rolls back together); otherwise they
 * check a client out of the pool for a single read and release it.
 *
 * `AsyncLocalStorage` is a Node built-in (`node:async_hooks`), not an I/O
 * library, so it does not compromise domain purity — and this file lives in
 * infrastructure regardless, so the layering rule is unaffected.
 */
export const txStorage: AsyncLocalStorage<PoolClient> = new AsyncLocalStorage();

/**
 * Runs `fn` with a `pg` client. If a transaction is ambient (set by the
 * {@link PostgresTransactionManager}), reuses that client and does NOT release
 * it (the manager owns its lifecycle). Otherwise checks a client out of the
 * pool for this call and releases it in `finally`.
 */
export async function withDbClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const ambient = txStorage.getStore();
  if (ambient) {
    return fn(ambient);
  }
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}