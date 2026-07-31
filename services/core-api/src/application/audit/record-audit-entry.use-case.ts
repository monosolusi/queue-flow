import {
  type AuditAction,
  type AuditSnapshot,
  AuditLogEntry,
  type IAuditLogRepository,
} from '../../domain/audit';

/**
 * Command for recording a single audited mutation (NFR-SEC-02). The mutating use
 * case supplies the actor (who initiated it), the {@link AuditAction} kind, and
 * the before/after snapshots of the affected entity. `before` is `null` for a
 * creation. The use case mints the entry id and `occurredAt` internally.
 */
export interface RecordAuditEntryCommand {
  readonly actor: string;
  readonly action: AuditAction;
  readonly before: AuditSnapshot | null;
  readonly after: AuditSnapshot;
}

/** Outcome of a recorded audit entry — the entry id + when it was recorded. */
export interface RecordedAuditEntryResult {
  readonly id: string;
  readonly occurredAt: number;
}

/**
 * Records one {@link AuditLogEntry} in the append-only audit log (NFR-SEC-02).
 * Thin and intentionally framework-free: depends only on the
 * {@link IAuditLogRepository} port (DIP) and a clock for `occurredAt` — no ORM,
 * HTTP framework, or I/O library (mirrors the Domain purity rule, NFR-MNT-01).
 *
 * **Atomicity:** mutating use cases call this inside their own
 * `ITransactionManager.runInTransaction` block. The repository `append` enlists
 * on the ambient transaction client, so the audit record commits (or rolls
 * back) together with the mutation it documents — a rolled-back mutation leaves
 * no orphan audit entry.
 */
export class RecordAuditEntryUseCase {
  constructor(
    private readonly auditLog: IAuditLogRepository,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  public async execute(command: RecordAuditEntryCommand): Promise<RecordedAuditEntryResult> {
    const occurredAt = this.clock();
    const entry = AuditLogEntry.of({
      actor: command.actor,
      action: command.action,
      before: command.before,
      after: command.after,
      occurredAt,
    });
    await this.auditLog.append(entry);
    return { id: entry.id, occurredAt };
  }
}