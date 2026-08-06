import { Identifier } from '../../src/domain/shared';
import { Category, QueueTicket, TicketNumber, TicketStatus, ticketIdGenerate } from '../../src/domain/queue';
import { StateMachine, StateSchema, StateTransitionRule } from '../../src/domain/store-config';
import {
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { InMemoryReportQueryRepository } from '../../src/infrastructure/persistence/in-memory/in-memory-report-query.repository';

/** The PRD §7 default state machine — used to drive tickets through the lifecycle. */
const policy = StateMachine.DEFAULT;

const DAY = '2026-08-01';
/** Local-midnight epoch for 2026-08-01. */
const DAY_START = new Date(2026, 7, 1).getTime();
const MS_PER_DAY = 86_400_000;

function category(code: string, name: string): Category {
  return new Category(Identifier.generate(), code, name);
}

function newTicket(categoryId: string, createdAt: number): QueueTicket {
  return QueueTicket.create(ticketIdGenerate(), TicketNumber.of('A', 1), categoryId, createdAt);
}

describe('InMemoryReportQueryRepository (QUE-26 CQRS read side)', () => {
  let queue: InMemoryQueueRepository;
  let categories: InMemoryCategoryRepository;
  let reportQuery: InMemoryReportQueryRepository;

  beforeEach(() => {
    queue = new InMemoryQueueRepository();
    categories = new InMemoryCategoryRepository();
    reportQuery = new InMemoryReportQueryRepository(queue, categories);
  });

  it('returns null when no tickets exist for the date', async () => {
    expect(await reportQuery.dailyReport(DAY)).toBeNull();
  });

  it('computes totals, avg wait time, avg service time, and per-category breakdown', async () => {
    const catA = category('A', 'Customer Service');
    const catB = category('B', 'Kasir');
    await categories.save(catA);
    await categories.save(catB);

    // Ticket 1 (A): wait 10s, service 30s.
    const t1 = newTicket(catA.id.value, DAY_START + 1000);
    t1.markCalling(1, policy, DAY_START + 11000); // calledAt - createdAt = 10000
    t1.startServing(policy, DAY_START + 12000);
    t1.complete(policy, DAY_START + 42000); // completedAt - servedAt = 30000
    t1.pullDomainEvents();

    // Ticket 2 (A): still waiting — contributes to total + per-category count, but not averages.
    const t2 = newTicket(catA.id.value, DAY_START + 5000);
    t2.pullDomainEvents();

    // Ticket 3 (B): called but not served — wait only.
    const t3 = newTicket(catB.id.value, DAY_START + 2000);
    t3.markCalling(2, policy, DAY_START + 7000); // wait 5000
    t3.pullDomainEvents();

    await queue.save(t1);
    await queue.save(t2);
    await queue.save(t3);

    const report = await reportQuery.dailyReport(DAY);

    expect(report).not.toBeNull();
    expect(report!.date).toBe(DAY);
    expect(report!.totalTickets).toBe(3);
    // avg wait over the two called tickets: (10000 + 5000) / 2 = 7500
    expect(report!.avgWaitTimeMs).toBe(7500);
    // avg service over the one completed ticket: 30000
    expect(report!.avgServiceTimeMs).toBe(30000);

    const byCode = new Map(report!.perCategory.map((c) => [c.code, c]));
    expect(byCode.get('A')!).toEqual({
      categoryId: catA.id.value,
      code: 'A',
      totalTickets: 2,
      avgWaitTimeMs: 10000, // only t1 was called
      avgServiceTimeMs: 30000,
    });
    expect(byCode.get('B')!).toEqual({
      categoryId: catB.id.value,
      code: 'B',
      totalTickets: 1,
      avgWaitTimeMs: 5000,
      avgServiceTimeMs: 0, // none served
    });
  });

  it('reads archived tickets for a past-day report (after a daily-reset archive)', async () => {
    const catA = category('A', 'Customer Service');
    await categories.save(catA);

    const prior = newTicket(catA.id.value, DAY_START - MS_PER_DAY + 1000); // previous day
    prior.markCalling(1, policy, DAY_START - MS_PER_DAY + 11000);
    prior.startServing(policy, DAY_START - MS_PER_DAY + 12000);
    prior.complete(policy, DAY_START - MS_PER_DAY + 42000);
    prior.pullDomainEvents();
    await queue.save(prior);
    // A daily reset relocated prior-day tickets to the archive.
    await queue.archiveTicketsBefore(DAY_START);

    const report = await reportQuery.dailyReport('2026-07-31');
    expect(report).not.toBeNull();
    expect(report!.totalTickets).toBe(1);
    expect(report!.avgServiceTimeMs).toBe(30000);
  });

  it('excludes tickets outside the date window', async () => {
    const catA = category('A', 'Customer Service');
    await categories.save(catA);
    const other = newTicket(catA.id.value, DAY_START + MS_PER_DAY + 1000); // next day
    other.pullDomainEvents();
    await queue.save(other);

    expect(await reportQuery.dailyReport(DAY)).toBeNull();
  });

  it('counterPerformance returns null when the counter served nothing that day', async () => {
    expect(await reportQuery.counterPerformance(1, DAY)).toBeNull();
  });

  it('counterPerformance computes served count + avg service time for a counter', async () => {
    const catA = category('A', 'Customer Service');
    await categories.save(catA);

    const t1 = newTicket(catA.id.value, DAY_START + 1000);
    t1.markCalling(1, policy, DAY_START + 11000);
    t1.startServing(policy, DAY_START + 12000);
    t1.complete(policy, DAY_START + 42000); // service 30000
    t1.pullDomainEvents();

    const t2 = newTicket(catA.id.value, DAY_START + 2000);
    t2.markCalling(1, policy, DAY_START + 12000);
    t2.startServing(policy, DAY_START + 13000);
    t2.complete(policy, DAY_START + 49000); // service 36000
    t2.pullDomainEvents();

    // A ticket called to a different counter does not count.
    const t3 = newTicket(catA.id.value, DAY_START + 3000);
    t3.markCalling(2, policy, DAY_START + 13000);
    t3.startServing(policy, DAY_START + 14000);
    t3.complete(policy, DAY_START + 50000);
    t3.pullDomainEvents();

    await queue.save(t1);
    await queue.save(t2);
    await queue.save(t3);

    const perf = await reportQuery.counterPerformance(1, DAY);
    expect(perf).not.toBeNull();
    expect(perf!.counterId).toBe(1);
    expect(perf!.ticketsServed).toBe(2);
    expect(perf!.avgServiceTimeMs).toBe(33000); // (30000 + 36000) / 2
  });

  describe('rangeReport (FR-ADM-03 / QUE-44)', () => {
    it('returns null when no tickets exist in the range', async () => {
      expect(await reportQuery.rangeReport('2026-08-01', '2026-08-03')).toBeNull();
    });

    it('computes a per-day series incl. zero-point rows for empty days, plus range totals', async () => {
      const catA = category('A', 'Customer Service');
      await categories.save(catA);

      // Day 1: one completed ticket (wait 10s, service 30s).
      const t1 = newTicket(catA.id.value, DAY_START + 1000);
      t1.markCalling(1, policy, DAY_START + 11000);
      t1.startServing(policy, DAY_START + 12000);
      t1.complete(policy, DAY_START + 42000);
      t1.pullDomainEvents();

      // Day 2: one waiting ticket (no call).
      const t2 = newTicket(catA.id.value, DAY_START + MS_PER_DAY + 2000);
      t2.pullDomainEvents();

      await queue.save(t1);
      await queue.save(t2);

      const report = await reportQuery.rangeReport(DAY, '2026-08-03');

      expect(report).not.toBeNull();
      expect(report!.from).toBe(DAY);
      expect(report!.to).toBe('2026-08-03');
      expect(report!.totalTickets).toBe(2);
      // avg wait over the one called ticket = 10000
      expect(report!.avgWaitTimeMs).toBe(10000);
      // avg service over the one completed ticket = 30000
      expect(report!.avgServiceTimeMs).toBe(30000);

      // 3-day series, day 2 empty (zero-point row), ordered by date.
      expect(report!.perDay).toHaveLength(3);
      expect(report!.perDay.map((p) => p.date)).toEqual([
        '2026-08-01',
        '2026-08-02',
        '2026-08-03',
      ]);
      expect(report!.perDay[0]).toEqual({
        date: '2026-08-01',
        totalTickets: 1,
        avgWaitTimeMs: 10000,
        avgServiceTimeMs: 30000,
        ticketsServed: 1,
      });
      expect(report!.perDay[1]).toEqual({
        date: '2026-08-02',
        totalTickets: 1,
        avgWaitTimeMs: 0,
        avgServiceTimeMs: 0,
        ticketsServed: 0,
      });
      expect(report!.perDay[2]).toEqual({
        date: '2026-08-03',
        totalTickets: 0,
        avgWaitTimeMs: 0,
        avgServiceTimeMs: 0,
        ticketsServed: 0,
      });
    });

    it('aggregates per-category and per-counter over the range', async () => {
      const catA = category('A', 'Customer Service');
      const catB = category('B', 'Kasir');
      await categories.save(catA);
      await categories.save(catB);

      // Day 1 counter 1 cat A: completed (service 30s).
      const t1 = newTicket(catA.id.value, DAY_START + 1000);
      t1.markCalling(1, policy, DAY_START + 11000);
      t1.startServing(policy, DAY_START + 12000);
      t1.complete(policy, DAY_START + 42000);
      t1.pullDomainEvents();

      // Day 2 counter 1 cat B: completed (service 40s).
      const t2 = newTicket(catB.id.value, DAY_START + MS_PER_DAY + 1000);
      t2.markCalling(1, policy, DAY_START + MS_PER_DAY + 11000);
      t2.startServing(policy, DAY_START + MS_PER_DAY + 12000);
      t2.complete(policy, DAY_START + MS_PER_DAY + 52000);
      t2.pullDomainEvents();

      // Day 2 counter 2 cat A: waiting (not served).
      const t3 = newTicket(catA.id.value, DAY_START + MS_PER_DAY + 3000);
      t3.pullDomainEvents();

      await queue.save(t1);
      await queue.save(t2);
      await queue.save(t3);

      const report = await reportQuery.rangeReport(DAY, '2026-08-02');
      expect(report).not.toBeNull();

      const byCode = new Map(report!.perCategory.map((c) => [c.code, c]));
      expect(byCode.get('A')!).toEqual({
        categoryId: catA.id.value,
        code: 'A',
        totalTickets: 2,
        avgWaitTimeMs: 10000, // only t1 was called
        avgServiceTimeMs: 30000, // only t1 was served
      });
      expect(byCode.get('B')!).toEqual({
        categoryId: catB.id.value,
        code: 'B',
        totalTickets: 1,
        avgWaitTimeMs: 10000,
        avgServiceTimeMs: 40000,
      });

      // Counter 1 served 2 (services 30000 + 40000 → avg 35000); counter 2 served 0 → omitted.
      expect(report!.perCounter).toEqual([
        { counterId: 1, ticketsServed: 2, avgServiceTimeMs: 35000 },
      ]);
    });

    it('excludes tickets outside the range window', async () => {
      const catA = category('A', 'Customer Service');
      await categories.save(catA);
      const before = newTicket(catA.id.value, DAY_START - MS_PER_DAY + 1000); // before range
      const after = newTicket(catA.id.value, DAY_START + 2 * MS_PER_DAY + 1000); // after range
      before.pullDomainEvents();
      after.pullDomainEvents();
      await queue.save(before);
      await queue.save(after);

      expect(await reportQuery.rangeReport(DAY, '2026-08-01')).toBeNull();
    });

    it('reads archived tickets for a past-day range (after a daily-reset archive)', async () => {
      const catA = category('A', 'Customer Service');
      await categories.save(catA);

      const prior = newTicket(catA.id.value, DAY_START - MS_PER_DAY + 1000); // 2026-07-31
      prior.markCalling(1, policy, DAY_START - MS_PER_DAY + 11000);
      prior.startServing(policy, DAY_START - MS_PER_DAY + 12000);
      prior.complete(policy, DAY_START - MS_PER_DAY + 42000);
      prior.pullDomainEvents();
      await queue.save(prior);
      await queue.archiveTicketsBefore(DAY_START); // archive 2026-07-31

      const report = await reportQuery.rangeReport('2026-07-31', '2026-08-01');
      expect(report).not.toBeNull();
      expect(report!.totalTickets).toBe(1);
      expect(report!.perDay).toHaveLength(2);
      expect(report!.perDay[0].totalTickets).toBe(1);
      expect(report!.perDay[1].totalTickets).toBe(0);
    });
  });
});