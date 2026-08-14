import { QueueTicket, TicketNumber, ticketIdGenerate } from '../../src/domain/queue';
import { PriorityPolicy, StateMachine } from '../../src/domain/store-config';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';

function waiting(categoryId: string, createdAt: number, seq: number): QueueTicket {
  return QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', seq),
    categoryId,
    createdAt,
  );
}

/** A ticket called to `counterId` (WAITING -> CALLING) via the default machine. */
function calling(categoryId: string, createdAt: number, seq: number, counterId: number): QueueTicket {
  const ticket = waiting(categoryId, createdAt, seq);
  ticket.markCalling(counterId, StateMachine.DEFAULT, createdAt + 1);
  return ticket;
}

/** A ticket called to `counterId` then skipped at `skippedAt` (CALLING -> SKIPPED). */
function skipped(
  categoryId: string,
  createdAt: number,
  seq: number,
  counterId: number,
  skippedAt: number,
): QueueTicket {
  const ticket = calling(categoryId, createdAt, seq, counterId);
  ticket.applyTransition('SKIPPED', StateMachine.DEFAULT, skippedAt);
  return ticket;
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

  describe('findSkippedByCounter (the caller panel\'s recall surface)', () => {
    it('returns only SKIPPED tickets assigned to that counter, oldest skip first', async () => {
      const repo = new InMemoryQueueRepository();
      await repo.save(skipped('CAT-A', 100, 1, 1, 400)); // skipped later
      await repo.save(skipped('CAT-A', 200, 2, 1, 300)); // skipped earlier
      await repo.save(skipped('CAT-A', 300, 3, 2, 350)); // other counter
      await repo.save(calling('CAT-A', 400, 4, 1)); // same counter, still CALLING
      await repo.save(waiting('CAT-A', 500, 5)); // never called

      const result = await repo.findSkippedByCounter(1);

      expect(result.map((t) => t.ticketNumber.sequence)).toEqual([2, 1]);
    });

    it('returns an empty list when the counter skipped nothing', async () => {
      const repo = new InMemoryQueueRepository();
      await repo.save(skipped('CAT-A', 100, 1, 2, 300));

      expect(await repo.findSkippedByCounter(1)).toEqual([]);
    });

    it('drops a ticket out of the skipped list once it is recalled', async () => {
      // The bucket tracks live status, so "Panggil Ulang" empties it — the same
      // aggregate instance moves SKIPPED -> CALLING and is re-saved.
      const repo = new InMemoryQueueRepository();
      const ticket = skipped('CAT-A', 100, 1, 1, 300);
      await repo.save(ticket);
      expect(await repo.findSkippedByCounter(1)).toHaveLength(1);

      ticket.applyTransition('CALLING', StateMachine.DEFAULT, 400);
      await repo.save(ticket);

      expect(await repo.findSkippedByCounter(1)).toEqual([]);
      expect((await repo.findActiveByCounter(1)).map((t) => t.ticketNumber.sequence)).toEqual([1]);
    });
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