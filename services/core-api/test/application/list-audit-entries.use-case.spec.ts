import { AuditAction, AuditLogEntry } from '../../src/domain/audit';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/persistence/in-memory';
import { ListAuditEntriesUseCase } from '../../src/application/audit';

describe('ListAuditEntriesUseCase (NFR-SEC-02 / FR-ADM-03 / QUE-26)', () => {
  let auditLog: InMemoryAuditLogRepository;
  let useCase: ListAuditEntriesUseCase;

  beforeEach(() => {
    auditLog = new InMemoryAuditLogRepository();
    useCase = new ListAuditEntriesUseCase(auditLog);
  });

  it('returns an empty list when no audit entries exist', async () => {
    expect(await useCase.execute()).toEqual([]);
  });

  it('projects each entry to the transport DTO (action serialized to string)', async () => {
    const e1 = AuditLogEntry.of({
      actor: 'admin',
      action: AuditAction.MANUAL_RESET,
      before: null,
      after: { resetTo: 1 },
      occurredAt: 1000,
    });
    const e2 = AuditLogEntry.of({
      actor: 'admin',
      action: AuditAction.STATE_SCHEMA_CHANGE,
      before: { states: ['WAITING'] },
      after: { states: ['WAITING', 'CALLING'] },
      occurredAt: 2000,
    });
    await auditLog.append(e1);
    await auditLog.append(e2);

    const result = await useCase.execute();

    expect(result).toEqual([
      {
        id: e1.id,
        actor: 'admin',
        action: AuditAction.MANUAL_RESET,
        before: null,
        after: { resetTo: 1 },
        occurredAt: 1000,
      },
      {
        id: e2.id,
        actor: 'admin',
        action: AuditAction.STATE_SCHEMA_CHANGE,
        before: { states: ['WAITING'] },
        after: { states: ['WAITING', 'CALLING'] },
        occurredAt: 2000,
      },
    ]);
  });

  it('lists entries oldest-first (the repository ordering is preserved)', async () => {
    await auditLog.append(
      AuditLogEntry.of({
        actor: 'admin',
        action: AuditAction.MANUAL_RESET,
        before: null,
        after: {},
        occurredAt: 5000,
      }),
    );
    await auditLog.append(
      AuditLogEntry.of({
        actor: 'admin',
        action: AuditAction.MANUAL_RESET,
        before: null,
        after: {},
        occurredAt: 1000,
      }),
    );

    const result = await useCase.execute();
    expect(result.map((e) => e.occurredAt)).toEqual([5000, 1000]);
  });
});