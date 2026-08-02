import { AuditAction } from '../../src/domain/audit';
import { InvalidArgumentException } from '../../src/domain/shared';
import {
  CleanupTransactionLogUseCase,
  MIN_RETENTION_DAYS,
} from '../../src/application/queue/cleanup-transaction-log.use-case';
import { RecordAuditEntryUseCase } from '../../src/application/audit/record-audit-entry.use-case';
import {
  InMemoryAuditLogRepository,
  InMemoryQueueRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { QueueTicket, TicketNumber, ticketIdGenerate } from '../../src/domain/queue';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed "now" (epoch-ms) used as the deterministic clock value. */
const NOW = new Date(2026, 0, 15, 10, 30).getTime(); // 2026-01-15 10:30 local
/** Local midnight of NOW — the cleanup threshold is anchored here. */
const START_OF_TODAY = new Date(2026, 0, 15).getTime();

/**
 * Seeds `count` archived tickets whose `createdAt` is `daysBeforeToday` days
 * before the start of today, by saving them as active then archiving them.
 */
async function seedArchived(repo: InMemoryQueueRepository, daysBeforeToday: number, seq: number) {
  const createdAt = START_OF_TODAY - daysBeforeToday * DAY_MS;
  const ticket = QueueTicket.create(ticketIdGenerate(), TicketNumber.of('A', seq), 'CAT-A', createdAt);
  await repo.save(ticket);
  // Archive by moving everything older than a far-future threshold.
  await repo.archiveTicketsBefore(Number.MAX_SAFE_INTEGER);
}

describe('CleanupTransactionLogUseCase (QUE-25 / FR-ADM-02)', () => {
  let archive: InMemoryQueueRepository;
  let auditLog: InMemoryAuditLogRepository;
  let useCase: CleanupTransactionLogUseCase;

  beforeEach(() => {
    archive = new InMemoryQueueRepository();
    auditLog = new InMemoryAuditLogRepository();
    useCase = new CleanupTransactionLogUseCase(
      archive,
      () => NOW,
      new RecordAuditEntryUseCase(auditLog, () => NOW),
    );
  });

  it('purges archived transactions older than the retention window and returns the count', async () => {
    // 90-day retention → threshold = START_OF_TODAY - 90 days. A 100-day-old
    // archived ticket is purged; a 30-day-old one is kept.
    await seedArchived(archive, 100, 1);
    await seedArchived(archive, 30, 2);
    expect(archive.archivedTickets()).toHaveLength(2);

    const result = await useCase.execute({ retentionDays: 90, actor: 'admin' });

    expect(result).toEqual({ status: 'cleaned', retentionDays: 90, deletedCount: 1 });
    const remaining = archive.archivedTickets().map((t) => t.ticketNumber.sequence);
    expect(remaining).toEqual([2]);
  });

  it('records a TRANSACTION_LOG_CLEANUP audit entry on the manual (actor) path (NFR-SEC-02)', async () => {
    await seedArchived(archive, 100, 1);

    await useCase.execute({ retentionDays: 90, actor: 'admin' });

    const entries = await auditLog.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.action).toBe(AuditAction.TRANSACTION_LOG_CLEANUP);
    expect(entry.actor).toBe('admin');
    expect(entry.before).toEqual({ olderThan: START_OF_TODAY - 90 * DAY_MS });
    expect(entry.after).toEqual({ deletedCount: 1, retentionDays: 90 });
  });

  it('does NOT record an audit entry when actor is absent (no automatic path is audited)', async () => {
    await seedArchived(archive, 100, 1);

    await useCase.execute({ retentionDays: 90 });

    expect(await auditLog.list()).toHaveLength(0);
    // The purge still ran.
    expect(archive.archivedTickets()).toHaveLength(0);
  });

  it('rejects a retention window below the floor before opening the transaction (no rows burned, NFR-REL-02)', async () => {
    await seedArchived(archive, 100, 1);

    await expect(useCase.execute({ retentionDays: MIN_RETENTION_DAYS - 1, actor: 'admin' })).rejects.toThrow(
      InvalidArgumentException,
    );
    // Nothing was purged and nothing was audited.
    expect(archive.archivedTickets()).toHaveLength(1);
    expect(await auditLog.list()).toHaveLength(0);
  });

  it('rejects a non-integer retention window', async () => {
    await seedArchived(archive, 100, 1);

    await expect(useCase.execute({ retentionDays: 10.5, actor: 'admin' })).rejects.toThrow(
      InvalidArgumentException,
    );
    expect(archive.archivedTickets()).toHaveLength(1);
  });

  it('accepts the minimum floor (boundary) and purges accordingly', async () => {
    // A ticket exactly MIN_RETENTION_DAYS + 1 days old is older than the
    // threshold (START_OF_TODAY - MIN_RETENTION_DAYS days) and is purged.
    await seedArchived(archive, MIN_RETENTION_DAYS + 1, 1);

    const result = await useCase.execute({ retentionDays: MIN_RETENTION_DAYS, actor: 'admin' });

    expect(result.deletedCount).toBe(1);
  });

  it('never touches the audit log table — only archived_tickets is purged', async () => {
    // Pre-seed an unrelated audit entry; cleanup must not remove it.
    const preAudit = new RecordAuditEntryUseCase(auditLog, () => NOW);
    await preAudit.execute({
      actor: 'admin',
      action: AuditAction.MANUAL_RESET,
      before: null,
      after: { resetTo: 1 },
    });
    await seedArchived(archive, 100, 1);

    await useCase.execute({ retentionDays: 90, actor: 'admin' });

    // The pre-existing MANUAL_RESET entry plus the new TRANSACTION_LOG_CLEANUP
    // entry remain — the audit log is never purged.
    const entries = await auditLog.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.action)).toContain(AuditAction.MANUAL_RESET);
    expect(entries.map((e) => e.action)).toContain(AuditAction.TRANSACTION_LOG_CLEANUP);
  });
});