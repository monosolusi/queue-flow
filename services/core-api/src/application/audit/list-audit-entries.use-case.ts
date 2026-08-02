import type { IAuditLogRepository } from '../../domain/audit';
import type { AuditLogEntry, AuditSnapshot } from '../../domain/audit';

/** Transport-agnostic projection of {@link AuditLogEntry} for the admin audit-trail view. */
export interface AuditLogEntryDto {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly before: AuditSnapshot | null;
  readonly after: AuditSnapshot;
  readonly occurredAt: number;
}

/**
 * Projects a single {@link AuditLogEntry} into an {@link AuditLogEntryDto}. The
 * single mapping point — use cases never return the domain value object itself
 * (DIP / no domain leakage), mirroring the other read-side use cases. `action`
 * is serialized to its string value so the DTO is plain JSON over the wire.
 */
export function projectAuditLogEntry(entry: AuditLogEntry): AuditLogEntryDto {
  return {
    id: entry.id,
    actor: entry.actor,
    action: entry.action,
    before: entry.before,
    after: entry.after,
    occurredAt: entry.occurredAt,
  };
}

/**
 * Read-side use case: lists the local audit trail for the admin analytics
 * dashboard (NFR-SEC-02 / FR-ADM-03). The audit log records human-initiated
 * mutations (manual reset, state-schema / routing changes, prior-day archive);
 * this read surfaces them oldest-first so the manager can review sensitive
 * administrative actions.
 *
 * **Lives in the audit bounded context** (it owns {@link AuditLogEntry}),
 * mirroring the `ListCategoriesUseCase`-in-owning-context precedent — the read
 * stays in the context that owns the entity. Depends only on a port (DIP) —
 * framework-free application layer (NFR-MNT-01).
 */
export class ListAuditEntriesUseCase {
  constructor(private readonly auditLog: IAuditLogRepository) {}

  async execute(): Promise<readonly AuditLogEntryDto[]> {
    const entries = await this.auditLog.list();
    return entries.map(projectAuditLogEntry);
  }
}