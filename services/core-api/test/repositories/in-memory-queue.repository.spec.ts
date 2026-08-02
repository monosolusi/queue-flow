import { QueueTicket, TicketNumber, ticketIdGenerate } from '../../src/domain/queue';
import { PriorityPolicy } from '../../src/domain/store-config';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';

function waiting(categoryId: string, createdAt: number, seq: number): QueueTicket {
  return QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', seq),
    categoryId,
    createdAt,
  );
}

describe('InMemoryQueueRepository (IQueueRepository contract)', () => {
  it('save and findById round-trip', async () => {
    const repo = new InMemoryQueueRepository();
    const ticket = waiting('CAT-A', 100, 1);
    await repo.save(ticket);
    const found = await repo.findById(ticket.id);
    expect(found).not.toBeNull();
    expect(found?.ticketNumber.formatted()).toBe('A-001');
  });

  it('findById returns null for unknown id', async () => {
    const repo = new InMemoryQueueRepository();
    expect(await repo.findById(ticketIdGenerate())).toBeNull();
  });

  it('findWaitingByCategory returns oldest first', async () => {
    const repo = new InMemoryQueueRepository();
    await repo.save(waiting('CAT-A', 300, 3));
    await repo.save(waiting('CAT-A', 100, 1));
    await repo.save(waiting('CAT-A', 200, 2));
    const result = await repo.findWaitingByCategory('CAT-A');
    expect(result.map((t) => t.ticketNumber.sequence)).toEqual([1, 2, 3]);
  });

  it('findNextWaiting (FIFO_GLOBAL) picks the oldest ticket across assigned categories', async () => {
    const repo = new InMemoryQueueRepository();
    await repo.save(waiting('CAT-A', 100, 1));
    await repo.save(waiting('CAT-B', 50, 2)); // oldest overall
    await repo.save(waiting('CAT-A', 200, 3));
    const next = await repo.findNextWaiting({
      assignedCategoryIds: ['CAT-A', 'CAT-B'],
      priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
    });
    expect(next?.ticketNumber.sequence).toBe(2);
  });

  it('findNextWaiting (CATEGORY_PRIORITY) prefers the first assigned category even if a later one is older', async () => {
    const repo = new InMemoryQueueRepository();
    await repo.save(waiting('CAT-B', 50, 2)); // older, but lower-priority category
    await repo.save(waiting('CAT-A', 100, 1));
    const next = await repo.findNextWaiting({
      assignedCategoryIds: ['CAT-A', 'CAT-B'],
      priorityPolicy: PriorityPolicy.CATEGORY_PRIORITY,
    });
    expect(next?.ticketNumber.sequence).toBe(1);
  });

  it('findNextWaiting returns null when no waiting ticket matches the routing', async () => {
    const repo = new InMemoryQueueRepository();
    await repo.save(waiting('CAT-A', 100, 1));
    const next = await repo.findNextWaiting({
      assignedCategoryIds: ['CAT-B'],
      priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
    });
    expect(next).toBeNull();
  });

  it('findNextWaiting ignores non-WAITING tickets', async () => {
    const repo = new InMemoryQueueRepository();
    const called = waiting('CAT-A', 100, 1);
    // move it out of WAITING using the default state machine
    called.markCalling(1, (await import('../../src/domain/store-config')).StateMachine.DEFAULT, 101);
    await repo.save(called);
    await repo.save(waiting('CAT-A', 200, 2));
    const next = await repo.findNextWaiting({
      assignedCategoryIds: ['CAT-A'],
      priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
    });
    expect(next?.ticketNumber.sequence).toBe(2);
  });

  describe('purgeArchivedBefore (QUE-25 / FR-ADM-02)', () => {
    it('deletes only archived tickets strictly older than the threshold and returns the count', async () => {
      const repo = new InMemoryQueueRepository();
      // Seed three active tickets at distinct epochs, then archive them all by
      // archiving "before a far-future threshold" (moves every active ticket
      // into the archive store).
      const old = waiting('CAT-A', 100, 1);
      const mid = waiting('CAT-A', 200, 2);
      const young = waiting('CAT-A', 300, 3);
      await repo.save(old);
      await repo.save(mid);
      await repo.save(young);
      await repo.archiveTicketsBefore(400); // archive all three
      expect(repo.archivedTickets()).toHaveLength(3);

      // Purge everything older than 250 — deletes `old` (100) and `mid` (200),
      // keeps `young` (300, not strictly older than 250).
      const deleted = await repo.purgeArchivedBefore(250);
      expect(deleted).toBe(2);
      const remaining = repo.archivedTickets().map((t) => t.ticketNumber.sequence);
      expect(remaining).toEqual([3]);
    });

    it('returns 0 and touches nothing when no archived ticket is older than the threshold', async () => {
      const repo = new InMemoryQueueRepository();
      await repo.save(waiting('CAT-A', 100, 1));
      await repo.archiveTicketsBefore(400);
      const deleted = await repo.purgeArchivedBefore(50);
      expect(deleted).toBe(0);
      expect(repo.archivedTickets()).toHaveLength(1);
    });

    it('never touches the active tickets store', async () => {
      const repo = new InMemoryQueueRepository();
      const active = waiting('CAT-A', 50, 1); // older than the purge threshold but ACTIVE
      await repo.save(active);
      // Archive a different, even older ticket so the archive store is non-empty.
      const archived = waiting('CAT-A', 10, 2);
      await repo.save(archived);
      await repo.archiveTicketsBefore(20);

      await repo.purgeArchivedBefore(20);

      // The active ticket (createdAt 50, older than threshold 20) is NOT purged
      // — purge operates on the archive store only.
      expect(await repo.findById(active.id)).not.toBeNull();
    });
  });
});