import type { AuditLogEntry } from '../../../domain/audit';
import type { IAuditLogRepository } from '../../../domain/audit';

/**
 * In-memory {@link IAuditLogRepository} for unit/integration tests and local dev
 * (LSP-interchangeable with {@link PostgresAuditLogRepository} behind the same
 * port). Append-only: entries are kept in insertion order and `list` returns them
 * oldest-first. There is no transaction concept here — the in-memory profile uses
 * the no-op `ITransactionManager`, so `append` is simply a synchronous push.
 */
export class InMemoryAuditLogRepository implements IAuditLogRepository {
  private readonly entries: AuditLogEntry[] = [];

  public async append(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  public async list(): Promise<AuditLogEntry[]> {
    return [...this.entries];
  }

  /** Test/dev helper: clears the in-memory log (mirrors the other in-memory repos). */
  public clear(): void {
    this.entries.length = 0;
  }
}