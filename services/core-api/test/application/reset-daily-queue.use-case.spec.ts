import { toDateKey, startOfLocalDay } from '../../src/application/queue';
import { ResetDailyQueueUseCase } from '../../src/application/queue';
import { NoOpTransactionManager } from '../../src/domain/shared';
import { RecordAuditEntryUseCase } from '../../src/application/audit/record-audit-entry.use-case';
import { AuditAction, type AuditLogEntry, type IAuditLogRepository } from '../../src/domain/audit';
import { SYSTEM_AGGREGATE_ID } from '../../src/domain/queue';
import { spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;
const EXPECTED_DATE = toDateKey(FIXED_NOW);

/** A minimal mock sequence repo — only `resetDaily` is exercised here. */
function mockSequences(): any {
  return {
    resetDaily: jest.fn(async () => undefined),
    nextTicketNumber: jest.fn(),
    currentSequence: jest.fn(),
  };
}

describe('ResetDailyQueueUseCase (daily reset engine — FR-ENG-05)', () => {
  let sequences: ReturnType<typeof mockSequences>;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: ResetDailyQueueUseCase;

  beforeEach(() => {
    sequences = mockSequences();
    dispatcher = spyDispatcher();
    useCase = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW);
  });

  it('rolls the per-day sequence back to resetTo for today (derived from the clock)', async () => {
    const result = await useCase.execute({ resetTo: 1 });

    expect(result).toEqual({ status: 'reset', date: EXPECTED_DATE, resetTo: 1 });
    expect(sequences.resetDaily).toHaveBeenCalledTimes(1);
    expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 1);
  });

  it('emits a SYSTEM_RESET event carrying resetTo and the date, via dispatchEvents', async () => {
    await useCase.execute({ resetTo: 5 });

    // System reset is not an aggregate-root operation, so it is published through
    // dispatchEvents (free-standing domain events), not dispatch (FR-ENG-04/05).
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(dispatcher.dispatchEvents).toHaveBeenCalledTimes(1);

    const events = dispatcher.dispatchEvents.mock.calls[0][0] as readonly any[];
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.type).toBe('SYSTEM_RESET');
    expect(event.aggregateId).toBe(SYSTEM_AGGREGATE_ID);
    expect(event.resetTo).toBe(5);
    expect(event.date).toBe(EXPECTED_DATE);
    expect(event.occurredAt).toBe(FIXED_NOW);
  });

  it('forwards the configured resetTo value through to resetDaily', async () => {
    await useCase.execute({ resetTo: 101 });
    expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 101);
  });

  describe('manual reset audit trail (NFR-SEC-02)', () => {
    /** An audit-log spy that captures appended entries for assertions. */
    function capturingAuditLog(): IAuditLogRepository & { entries: AuditLogEntry[] } {
      const entries: AuditLogEntry[] = [];
      return {
        entries,
        append: jest.fn(async (entry: AuditLogEntry) => {
          entries.push(entry);
        }),
        list: jest.fn(async () => [...entries]),
      };
    }

    it('records a MANUAL_RESET audit entry when actor is present (manual path)', async () => {
      const auditLog = capturingAuditLog();
      const recordAudit = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);
      const manual = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW, recordAudit);

      await manual.execute({ resetTo: 1, actor: 'admin' });

      expect(auditLog.entries).toHaveLength(1);
      const [entry] = auditLog.entries;
      expect(entry.action).toBe(AuditAction.MANUAL_RESET);
      expect(entry.actor).toBe('admin');
      expect(entry.before).toBeNull();
      expect(entry.after).toEqual({ date: EXPECTED_DATE, resetTo: 1 });
      expect(entry.occurredAt).toBe(FIXED_NOW);
    });

    it('does NOT record an audit entry when actor is absent (automatic cron path)', async () => {
      const auditLog = capturingAuditLog();
      const recordAudit = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);
      const automatic = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW, recordAudit);

      await automatic.execute({ resetTo: 1 }); // no actor → automatic path

      expect(auditLog.entries).toHaveLength(0);
      // the reset still happened
      expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 1);
    });

    it('does not audit when no RecordAuditEntryUseCase is wired (default no-op)', async () => {
      // Constructs with only (sequences, dispatcher, clock) — the pre-audit shape.
      const plain = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW);

      await expect(plain.execute({ resetTo: 1, actor: 'admin' })).resolves.toEqual({
        status: 'reset',
        date: EXPECTED_DATE,
        resetTo: 1,
      });
      expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 1);
    });
  });

  describe('archive previous-day data (FR-WZD-05 / QUE-16)', () => {
    /** A minimal mock archive port — only `archiveTicketsBefore` is exercised. */
    function mockArchive(returnCount = 0): any {
      return { archiveTicketsBefore: jest.fn(async () => returnCount) };
    }

    /** An audit-log spy that captures appended entries for assertions. */
    function capturingAuditLog(): IAuditLogRepository & { entries: AuditLogEntry[] } {
      const entries: AuditLogEntry[] = [];
      return {
        entries,
        append: jest.fn(async (entry: AuditLogEntry) => {
          entries.push(entry);
        }),
        list: jest.fn(async () => [...entries]),
      };
    }

    it('archives prior-day tickets and returns archivedCount when archivePreviousDay is true', async () => {
      const archive = mockArchive(4);
      const useCase = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        null,
        new NoOpTransactionManager(),
        archive,
      );

      const result = await useCase.execute({ resetTo: 1, archivePreviousDay: true });

      expect(result).toEqual({
        status: 'reset',
        date: EXPECTED_DATE,
        resetTo: 1,
        archivedCount: 4,
      });
      // The threshold is local midnight today — anything older is a previous day.
      expect(archive.archiveTicketsBefore).toHaveBeenCalledTimes(1);
      expect(archive.archiveTicketsBefore).toHaveBeenCalledWith(startOfLocalDay(FIXED_NOW));
      expect(sequences.resetDaily).toHaveBeenCalledWith(EXPECTED_DATE, 1);
    });

    it('records ARCHIVE_PREVIOUS_DAY then MANUAL_RESET on the manual path (NFR-SEC-02)', async () => {
      const archive = mockArchive(3);
      const auditLog = capturingAuditLog();
      const recordAudit = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);
      const useCase = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        recordAudit,
        new NoOpTransactionManager(),
        archive,
      );

      await useCase.execute({ resetTo: 1, actor: 'admin', archivePreviousDay: true });

      // Two audit entries, in execution order: archive first, then the reset.
      expect(auditLog.entries).toHaveLength(2);
      expect(auditLog.entries[0].action).toBe(AuditAction.ARCHIVE_PREVIOUS_DAY);
      expect(auditLog.entries[0].actor).toBe('admin');
      expect(auditLog.entries[0].before).toBeNull();
      expect(auditLog.entries[0].after).toEqual({ date: EXPECTED_DATE, archivedCount: 3 });
      expect(auditLog.entries[1].action).toBe(AuditAction.MANUAL_RESET);
      expect(auditLog.entries[1].after).toEqual({ date: EXPECTED_DATE, resetTo: 1 });
    });

    it('does NOT archive and does NOT record ARCHIVE_PREVIOUS_DAY when archivePreviousDay is false', async () => {
      const archive = mockArchive(9);
      const auditLog = capturingAuditLog();
      const recordAudit = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);
      const useCase = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        recordAudit,
        new NoOpTransactionManager(),
        archive,
      );

      const result = await useCase.execute({ resetTo: 1, actor: 'admin' });

      // No archivedCount in the result when archiving is off (no contract drift).
      expect(result).toEqual({ status: 'reset', date: EXPECTED_DATE, resetTo: 1 });
      expect(archive.archiveTicketsBefore).not.toHaveBeenCalled();
      expect(auditLog.entries).toHaveLength(1);
      expect(auditLog.entries[0].action).toBe(AuditAction.MANUAL_RESET);
    });

    it('archives but records no audit entries on the automatic path (no actor)', async () => {
      const archive = mockArchive(7);
      const auditLog = capturingAuditLog();
      const recordAudit = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);
      const useCase = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        recordAudit,
        new NoOpTransactionManager(),
        archive,
      );

      const result = await useCase.execute({ resetTo: 1, archivePreviousDay: true });

      expect(result).toEqual({
        status: 'reset',
        date: EXPECTED_DATE,
        resetTo: 1,
        archivedCount: 7,
      });
      expect(archive.archiveTicketsBefore).toHaveBeenCalledWith(startOfLocalDay(FIXED_NOW));
      expect(auditLog.entries).toHaveLength(0);
    });

    it('treats archive as a no-op when no archive port is wired (graceful default)', async () => {
      // Pre-QUE-16 construction shape — no archive port. Archive flag is true but
      // there is nothing to archive through, so it degrades safely to archivedCount 0.
      const useCase = new ResetDailyQueueUseCase(sequences, dispatcher, () => FIXED_NOW);

      const result = await useCase.execute({ resetTo: 1, archivePreviousDay: true });

      expect(result).toEqual({
        status: 'reset',
        date: EXPECTED_DATE,
        resetTo: 1,
        archivedCount: 0,
      });
    });

    it('runs archive then sequence reset inside one transaction, and never broadcasts on rollback (NFR-REL-02)', async () => {
      const archive = mockArchive(2);
      const txManager = new NoOpTransactionManager();
      const spy = jest.spyOn(txManager, 'runInTransaction');
      const useCase = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        null,
        txManager,
        archive,
      );

      await useCase.execute({ resetTo: 1, archivePreviousDay: true });

      // Both the archive and the reset run inside the single tx callback, archive first.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(archive.archiveTicketsBefore).toHaveBeenCalledTimes(1);
      expect(sequences.resetDaily).toHaveBeenCalledTimes(1);
      expect(archive.archiveTicketsBefore.mock.invocationCallOrder[0]).toBeLessThan(
        sequences.resetDaily.mock.invocationCallOrder[0],
      );
      expect(dispatcher.dispatchEvents).toHaveBeenCalledTimes(1);

      // Now force the transaction to roll back (resetDaily throws) and assert the
      // SYSTEM_RESET event is never broadcast — a rolled-back reset must not leak.
      sequences.resetDaily.mockRejectedValueOnce(new Error('tx rolled back'));
      const failing = new ResetDailyQueueUseCase(
        sequences,
        dispatcher,
        () => FIXED_NOW,
        null,
        txManager,
        archive,
      );
      dispatcher.dispatchEvents.mockClear();

      await expect(failing.execute({ resetTo: 1, archivePreviousDay: true })).rejects.toThrow(
        'tx rolled back',
      );
      expect(dispatcher.dispatchEvents).not.toHaveBeenCalled();
    });
  });
});