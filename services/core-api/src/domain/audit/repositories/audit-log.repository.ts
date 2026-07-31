import type { AuditLogEntry } from '../audit-log-entry';

/**
 * NestJS DI token for {@link IAuditLogRepository}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so it does
 * not compromise domain purity (NFR-MNT-01).
 */
export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

/**
 * Repository abstraction for the append-only audit log (NFR-SEC-02).
 *
 * `append` is expected to enlist on the caller's active transaction when one is
 * available, so the audit record commits atomically with the mutation it
 * documents — a rolled-back mutation leaves no orphan audit entry. `list`
 * returns entries oldest-first for the admin reporting surface.
 */
export interface IAuditLogRepository {
  append(entry: AuditLogEntry): Promise<void>;
  list(): Promise<AuditLogEntry[]>;
}

/**
 * Pure no-op {@link IAuditLogRepository}. Lives in the domain (no framework
 * deps) so application use cases can default to it — keeping the optional
 * constructor parameter pattern that lets the existing unit specs construct use
 * cases directly without wiring a real audit sink (mirrors
 * {@link NoOpTransactionManager}). A no-op `append` means "no audit recorded",
 * which is exactly the semantics of the automatic (cron-driven) daily reset —
 * only the manual, human-triggered reset is audited (NFR-SEC-02).
 */
export class NoOpAuditLogRepository implements IAuditLogRepository {
  public async append(_entry: AuditLogEntry): Promise<void> {
    // intentionally no-op
  }
  public async list(): Promise<AuditLogEntry[]> {
    return [];
  }
}