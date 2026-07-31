import { AuditAction, AuditLogEntry } from '../../src/domain/audit';
import { InMemoryAuditLogRepository } from '../../src/infrastructure/persistence/in-memory';

describe('InMemoryAuditLogRepository (NFR-SEC-02)', () => {
  it('appends entries and lists them oldest-first', async () => {
    const repo = new InMemoryAuditLogRepository();
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

    await repo.append(e1);
    await repo.append(e2);

    const list = await repo.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(e1.id);
    expect(list[1].id).toBe(e2.id);
  });

  it('starts empty', async () => {
    const repo = new InMemoryAuditLogRepository();
    expect(await repo.list()).toEqual([]);
  });
});