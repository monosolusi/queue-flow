import { TicketNumber } from '../../src/domain/queue';
import { InMemorySequenceRepository } from '../../src/infrastructure/persistence/in-memory';

describe('InMemorySequenceRepository (ISequenceRepository contract)', () => {
  it('issues sequential numbers per category per day', async () => {
    const repo = new InMemorySequenceRepository();
    expect((await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30')).formatted()).toBe('A-001');
    expect((await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30')).formatted()).toBe('A-002');
    expect(await repo.currentSequence('CAT-A', '2026-07-30')).toBe(2);
  });

  it('isolates sequences across categories and dates', async () => {
    const repo = new InMemorySequenceRepository();
    await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30');
    expect((await repo.nextTicketNumber('CAT-B', 'B', '2026-07-30')).formatted()).toBe('B-001');
    expect((await repo.nextTicketNumber('CAT-A', 'A', '2026-07-31')).formatted()).toBe('A-001');
  });

  it('resetDaily rolls the sequence back so the next ticket is the reset value', async () => {
    const repo = new InMemorySequenceRepository();
    await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30');
    await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30');
    await repo.resetDaily('2026-07-30', 1);
    expect((await repo.nextTicketNumber('CAT-A', 'A', '2026-07-30')).formatted()).toBe('A-001');
  });

  it('resetDaily does not affect other dates', async () => {
    const repo = new InMemorySequenceRepository();
    await repo.nextTicketNumber('CAT-A', 'A', '2026-07-31');
    await repo.resetDaily('2026-07-30', 1);
    expect((await repo.nextTicketNumber('CAT-A', 'A', '2026-07-31')).formatted()).toBe('A-002');
  });
});