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
});