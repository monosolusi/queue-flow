import type { Pool } from 'pg';
import { AuditLogEntry, type AuditSnapshot, type AuditAction } from '../../../domain/audit';
import type { IAuditLogRepository } from '../../../domain/audit';
import { withDbClient } from './transaction-context';

interface AuditRow {
  id: string;
  actor: string;
  action: string;
  before: string | null;
  after: string;
  occurred_at: string;
}

/**
 * PostgreSQL {@link IAuditLogRepository} (QUE-30 / NFR-SEC-02). `append` inserts
 * into the `audit_log` table, enlisting on the ambient transaction client when
 * one is active (via {@link withDbClient}) so the audit record commits atomically
 * with the mutation it documents. `before` / `after` are JSON-serialized to the
 * table's TEXT columns; `before` is `NULL` when the entry records a creation.
 */
export class PostgresAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly pool: Pool) {}

  public async append(entry: AuditLogEntry): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO audit_log (id, actor, action, before, after, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.id,
          entry.actor,
          entry.action,
          entry.before === null ? null : JSON.stringify(entry.before),
          JSON.stringify(entry.after),
          entry.occurredAt,
        ],
      );
    });
  }

  public async list(): Promise<AuditLogEntry[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<AuditRow>(
        'SELECT id, actor, action, before, after, occurred_at FROM audit_log ORDER BY occurred_at ASC, id ASC',
      );
      return rows.map(toEntry);
    });
  }
}

function toEntry(row: AuditRow): AuditLogEntry {
  const before: AuditSnapshot | null = row.before === null ? null : JSON.parse(row.before);
  return AuditLogEntry.reconstitute({
    id: row.id,
    actor: row.actor,
    action: row.action as AuditAction,
    before,
    after: JSON.parse(row.after) as AuditSnapshot,
    occurredAt: Number(row.occurred_at),
  });
}