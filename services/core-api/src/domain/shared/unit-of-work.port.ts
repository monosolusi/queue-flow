/**
 * NestJS DI token for {@link ITransactionManager}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so it does
 * not compromise domain purity (NFR-MNT-01), mirroring the other port tokens.
 *
 * QUE-30 / NFR-REL-02: enables gap-free ticket creation. The ticket-generation
 * and call-next flows reserve a per-day sequence number and then insert the
 * ticket — two writes that must survive a power cut as one unit. The use cases
 * wrap both writes in {@link ITransactionManager.runInTransaction}; the
 * PostgreSQL implementation commits them atomically (WAL + `synchronous_commit`),
 * so a crash mid-operation rolls the sequence advance back too — no duplicates,
 * no gaps. The in-memory / no-op implementation is a pure pass-through.
 */
export const TRANSACTION_MANAGER = Symbol('TRANSACTION_MANAGER');

/**
 * Transactional boundary port (DIP). The application layer depends on this
 * abstraction; infrastructure supplies the concrete implementation (a no-op for
 * in-memory tests/dev, a `pg` `BEGIN`/`COMMIT`/`ROLLBACK` for PostgreSQL).
 *
 * The port is intentionally minimal — a single `runInTransaction` that runs
 * `work` inside a transaction and commits on success / rolls back on throw.
 * Repositories that wish to enlist detect the ambient connection via their own
 * infrastructure mechanism (the PostgreSQL impl uses `AsyncLocalStorage`); the
 * port itself carries no connection type so the domain stays I/O-free.
 */
export interface ITransactionManager {
  /**
   * Runs `work` inside a transaction. Resolves with `work`'s result on commit,
   * rejects (and rolls back) if `work` throws. Implementations MUST guarantee
   * atomicity across every repository write performed inside `work`.
   */
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Pure no-op implementation used as the default when no real transaction is
 * needed — in-memory tests/dev and any path that does not require durability.
 * Lives in the domain (no framework import) so the application layer can default
 * to it without reaching into infrastructure (preserving `application-no-
 * infrastructure`). It simply runs `work` with no boundary.
 */
export class NoOpTransactionManager implements ITransactionManager {
  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}