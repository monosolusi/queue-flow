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

/** A WAITING ticket with a `waitingOrder` distinct from `createdAt` (re-queued). */
function waitingAtOrder(
  categoryId: string,
  createdAt: number,
  waitingOrder: number,
  seq: number,
): QueueTicket {
  return QueueTicket.reconstitute({
    id: ticketIdGenerate(),
    ticketNumber: TicketNumber.of('A', seq),
    categoryId,
    status: 'WAITING',
    counterId: null,
    createdAt,
    updatedAt: createdAt,
    waitingOrder,
    calledAt: null,
    servedAt: null,
    completedAt: null,
  });
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

  it('findWaitingByCategory sorts by waiting_order ASC, created_at ASC (not createdAt alone)', async () => {
    // A re-queued ticket has a `waitingOrder` distinct from its `createdAt`.
    // seq 2 was re-queued to the back (waitingOrder 5000), so despite an early
    // createdAt (200) it sorts AFTER seq 1 (waitingOrder 1000) and seq 3
    // (waitingOrder 3000). `createdAt` is now only the tiebreak.
    const repo = new InMemoryQueueRepository();
    await repo.save(waitingAtOrder('CAT-A', 100, 1_000, 1));
    await repo.save(waitingAtOrder('CAT-A', 200, 5_000, 2));
    await repo.save(waitingAtOrder('CAT-A', 300, 3_000, 3));
    const result = await repo.findWaitingByCategory('CAT-A');
    expect(result.map((t) => t.ticketNumber.sequence)).toEqual([1, 3, 2]);
  });

  it('findWaitingByCategory breaks waiting_order ties by created_at ASC (the legacy key)', async () => {
    // Two tickets stamped the same waitingOrder sort by createdAt ASC — the
    // legacy FIFO origin is preserved as the deterministic tiebreak so a
    // backfill (waiting_order = created_at) keeps every pre-migration order.
    const repo = new InMemoryQueueRepository();
    await repo.save(waitingAtOrder('CAT-A', 300, 1_000, 3)); // later createdAt
    await repo.save(waitingAtOrder('CAT-A', 100, 1_000, 1)); // earlier createdAt
    await repo.save(waitingAtOrder('CAT-A', 200, 1_000, 2));
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

  it('findNextWaiting (FIFO_GLOBAL) honors waiting_order over createdAt', async () => {
    // seq 2 was re-queued to the back (waitingOrder 5000) — seq 1 (1000) is next
    // even though seq 2 has the earlier createdAt.
    const repo = new InMemoryQueueRepository();
    await repo.save(waitingAtOrder('CAT-A', 100, 1_000, 1));
    await repo.save(waitingAtOrder('CAT-A', 200, 5_000, 2));
    const next = await repo.findNextWaiting({
      assignedCategoryIds: ['CAT-A'],
      priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
    });
    expect(next?.ticketNumber.sequence).toBe(1);
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

  describe('assignWaitingOrders (the BACK_N renumber bulk write)', () => {
    it('bulk-writes each sibling waiting_order, preserving status and every other field', async () => {
      const repo = new InMemoryQueueRepository();
      const a = waitingAtOrder('CAT-A', 100, 1_000, 1);
      const b = waitingAtOrder('CAT-A', 200, 2_000, 2);
      const c = waitingAtOrder('CAT-A', 300, 3_000, 3);
      await repo.save(a);
      await repo.save(b);
      await repo.save(c);

      // Re-pack the category anchored at 100 with step 1000, inserting the
      // re-queued ticket at index 1 — so a stays at 100, b → 2100, c → 3100.
      await repo.assignWaitingOrders([
        { id: a.id, waitingOrder: 100 },
        { id: b.id, waitingOrder: 100 + 2 * 1000 },
        { id: c.id, waitingOrder: 100 + 3 * 1000 },
      ]);

      const reloadedB = await repo.findById(b.id);
      expect(reloadedB?.waitingOrder).toBe(2100);
      // Status and every other field are untouched — only the ordering key moved.
      expect(reloadedB?.currentStatus).toBe('WAITING');
      expect(reloadedB?.createdAt).toBe(200);
      expect(reloadedB?.ticketNumber.sequence).toBe(2);

      // The WAITING read now reflects the re-packed order.
      const waiting = await repo.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.sequence)).toEqual([1, 2, 3]);
      expect(waiting.map((t) => t.waitingOrder)).toEqual([100, 2100, 3100]);
    });

    it('is a no-op for an id not in the store (defensive — never throws)', async () => {
      const repo = new InMemoryQueueRepository();
      const ghost = ticketIdGenerate();
      await expect(
        repo.assignWaitingOrders([{ id: ghost, waitingOrder: 999 }]),
      ).resolves.toBeUndefined();
    });

    it('writes only the ordering key — no status change, no event (the renumber is order-only)', async () => {
      // The bulk write must NOT move a ticket into WAITING or out of it; it
      // re-stamps the ordering key of an already-WAITING sibling. A SKIPPED ticket
      // given an assignment stays SKIPPED (it is not in the WAITING read anyway).
      const repo = new InMemoryQueueRepository();
      const skippedTicket = waiting('CAT-A', 100, 1);
      skippedTicket.markCalling(1, StateMachine.DEFAULT, 101);
      skippedTicket.applyTransition('SKIPPED', StateMachine.DEFAULT, 200);
      await repo.save(skippedTicket);

      await repo.assignWaitingOrders([{ id: skippedTicket.id, waitingOrder: 5_000 }]);

      const reloaded = await repo.findById(skippedTicket.id);
      expect(reloaded?.currentStatus).toBe('SKIPPED');
      expect(reloaded?.waitingOrder).toBe(5_000);
      // The skipped ticket is NOT in the WAITING read despite the new order.
      expect(await repo.findWaitingByCategory('CAT-A')).toEqual([]);
    });
  });
});