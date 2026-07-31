import {
  AuditAction,
  type AuditLogEntry,
  type IAuditLogRepository,
} from '../../src/domain/audit';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/persistence/in-memory';
import { RecordAuditEntryUseCase } from '../../src/application/audit/record-audit-entry.use-case';

/**
 * An in-memory {@link IAuditLogRepository} that also exposes the recorded
 * entries so tests can assert what was appended (the real
 * {@link InMemoryAuditLogRepository} already does this via `list`, but keeping a
 * local reference avoids coupling the assertion to the impl's internal order).
 */
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

describe('RecordAuditEntryUseCase (audit trail — NFR-SEC-02)', () => {
  it('appends an AuditLogEntry built from the command, minting id + occurredAt from the clock', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const FIXED_NOW = 1_700_000_000_000;
    const useCase = new RecordAuditEntryUseCase(auditLog, () => FIXED_NOW);

    const result = await useCase.execute({
      actor: 'admin',
      action: AuditAction.MANUAL_RESET,
      before: null,
      after: { date: '2026-07-31', resetTo: 1 },
    });

    expect(result.occurredAt).toBe(FIXED_NOW);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4

    const entries = await auditLog.list();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.actor).toBe('admin');
    expect(entry.action).toBe(AuditAction.MANUAL_RESET);
    expect(entry.before).toBeNull();
    expect(entry.after).toEqual({ date: '2026-07-31', resetTo: 1 });
    expect(entry.occurredAt).toBe(FIXED_NOW);
    expect(entry.id).toBe(result.id);
  });

  it('rejects an empty actor (the VO self-validates)', async () => {
    const auditLog = new InMemoryAuditLogRepository();
    const useCase = new RecordAuditEntryUseCase(auditLog);

    await expect(
      useCase.execute({
        actor: '  ',
        action: AuditAction.ROUTING_CHANGE,
        before: null,
        after: {},
      }),
    ).rejects.toThrow(/actor must be non-empty/);

    expect(await auditLog.list()).toHaveLength(0); // nothing recorded on failure
  });

  it('records a before snapshot for a state-schema change', async () => {
    const log = capturingAuditLog();
    const useCase = new RecordAuditEntryUseCase(log, () => 1);

    await useCase.execute({
      actor: 'admin',
      action: AuditAction.STATE_SCHEMA_CHANGE,
      before: { states: ['WAITING', 'CALLING'] },
      after: { states: ['WAITING', 'CALLING', 'PREPARING'] },
    });

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].before).toEqual({ states: ['WAITING', 'CALLING'] });
    expect(log.entries[0].after).toEqual({ states: ['WAITING', 'CALLING', 'PREPARING'] });
  });
});