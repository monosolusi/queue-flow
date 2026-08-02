import type { ITicketArchivePort } from '../../domain/queue';
import { AuditAction } from '../../domain/audit';
import { InvalidArgumentException, type ITransactionManager, NoOpTransactionManager } from '../../domain/shared';
import { startOfLocalDay } from '../shared/date';
import { type RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';

/** Milliseconds in one 24-hour day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The enforced minimum retention window (in days) for the transaction-log
 * cleanup guardrail (QUE-25 / FR-ADM-02). A manager cannot purge archived
 * transactions newer than this floor, so a typo or a too-aggressive value can
 * never wipe recent history. The value is a deliberate business guardrail, not
 * a configurable setting — the audit trail (`audit_log`) is never purged at all
 * and archived transactions are kept for at least this long.
 */
export const MIN_RETENTION_DAYS = 7;

/**
 * Command for the transaction-log cleanup override (QUE-25 / FR-ADM-02). The
 * manager chooses a `retentionDays` window; every archived queue transaction
 * older than that window is permanently deleted from `archived_tickets`. The
 * use case derives the epoch-ms threshold internally (`startOfLocalDay(now) -
 * retentionDays * DAY_MS`) so the date convention stays in the application
 * layer (out of the domain), like the daily-reset archive step — reusing the
 * shared {@link startOfLocalDay} helper (QUE-26) rather than a queue-local copy.
 *
 * `actor` is present **only** for a manual, human-triggered cleanup (the admin
 * surface). When present, the cleanup is recorded in the audit log as
 * `TRANSACTION_LOG_CLEANUP` (NFR-SEC-02). There is no automatic/cron path, so
 * the presence of `actor` is the manual marker — mirroring the `MANUAL_RESET`
 * scoping in {@link ResetDailyQueueUseCase}.
 *
 * Anti-corruption: this command carries only scalars and never imports the
 * Store-Config context. The guardrail floor is a use-case-level business rule
 * (not a `SystemConfiguration` field), so changing the daily-reset policy does
 * not interact with cleanup retention.
 */
export interface CleanupTransactionLogCommand {
  readonly retentionDays: number;
  /** When set, the cleanup is manual and audited (NFR-SEC-02). */
  readonly actor?: string;
}

/** Outcome of a cleanup: how many archived transactions were purged. */
export type CleanupTransactionLogResult = {
  readonly status: 'cleaned';
  readonly retentionDays: number;
  readonly deletedCount: number;
};

/**
 * The transaction-log cleanup override (QUE-25 / FR-ADM-02). Permanently deletes
 * archived queue transactions older than a manager-chosen retention window via
 * {@link ITicketArchivePort.purgeArchivedBefore}. This is the eviction step that
 * keeps `archived_tickets` from growing unbounded as each daily reset relocates
 * prior-day tickets into it. The `audit_log` table is never touched — the audit
 * trail is the compliance record (NFR-SEC-02) and is preserved indefinitely.
 *
 * **Guardrail:** a `retentionDays` below {@link MIN_RETENTION_DAYS} (or
 * non-integer) is rejected with {@link InvalidArgumentException} **before** the
 * transaction opens — an illegal cleanup burns no rows (NFR-REL-02 pattern).
 *
 * **Atomicity + audit (NFR-REL-02 / NFR-SEC-02):** the purge and (for the manual
 * path) the audit append run inside one
 * {@link ITransactionManager.runInTransaction} block. The repositories enlist on
 * the ambient transaction client, so a power cut between the purge and the audit
 * record leaves neither half-committed — a rolled-back cleanup leaves no orphan
 * audit entry and no purged rows.
 *
 * `recordAudit` and `txManager` are **optional** with no-op defaults, so unit
 * specs that construct this use case directly (with only the archive port + a
 * deterministic clock) keep working unchanged.
 *
 * Depends only on ports (DIP): no ORM, HTTP framework, or I/O library, and no
 * Store-Config import (anti-corruption).
 */
export class CleanupTransactionLogUseCase {
  constructor(
    private readonly ticketArchive: ITicketArchivePort,
    private readonly clock: () => number = () => Date.now(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
  ) {}

  public async execute(command: CleanupTransactionLogCommand): Promise<CleanupTransactionLogResult> {
    // Guardrail: reject an under-floor or non-integer retention window before
    // opening the transaction so an illegal cleanup burns no rows (NFR-REL-02).
    if (
      !Number.isInteger(command.retentionDays) ||
      command.retentionDays < MIN_RETENTION_DAYS
    ) {
      throw new InvalidArgumentException(
        `Retention window must be an integer of at least ${MIN_RETENTION_DAYS} days (got ${command.retentionDays}).`,
      );
    }

    const now = this.clock();
    // The threshold is local midnight today minus the retention window — any
    // archived transaction strictly older than this is purged. Using local
    // midnight (not `now`) keeps the day boundary stable within a calendar day,
    // like the daily-reset archive step.
    const threshold = startOfLocalDay(now) - command.retentionDays * DAY_MS;

    const deletedCount = await this.txManager.runInTransaction(async () => {
      const deleted = await this.ticketArchive.purgeArchivedBefore(threshold);
      if (command.actor && this.recordAudit) {
        await this.recordAudit.execute({
          actor: command.actor,
          action: AuditAction.TRANSACTION_LOG_CLEANUP,
          before: { olderThan: threshold },
          after: { deletedCount: deleted, retentionDays: command.retentionDays },
        });
      }
      return deleted;
    });

    return { status: 'cleaned', retentionDays: command.retentionDays, deletedCount };
  }
}