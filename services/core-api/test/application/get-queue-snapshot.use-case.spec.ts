import { Identifier } from '../../src/domain/shared';
import { PriorityPolicy } from '../../src/domain/shared/priority-policy';
import { CounterRoutingRule } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
  type TicketId,
} from '../../src/domain/queue';
import { GetQueueSnapshotUseCase } from '../../src/application/queue';
import {
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { EntityNotFoundException } from '../../src/domain/shared';

/** A WAITING ticket created at `createdAt`. */
function waiting(categoryId: string, code: string, seq: number, createdAt: number): QueueTicket {
  return QueueTicket.create(ticketIdGenerate(), TicketNumber.of(code, seq), categoryId, createdAt);
}

/** A ticket reconstituted in an active (CALLING/SERVING) state at `counterId`. */
function active(
  categoryId: string,
  code: string,
  seq: number,
  counterId: number,
  status: 'CALLING' | 'SERVING',
  createdAt: number,
): QueueTicket {
  return QueueTicket.reconstitute({
    id: ticketIdGenerate() as TicketId,
    ticketNumber: TicketNumber.of(code, seq),
    categoryId,
    status,
    counterId,
    createdAt,
    updatedAt: createdAt,
  });
}

/** A routing rule for `counterId` serving `categoryIds` under `policy`. */
function rule(
  counterId: number,
  categoryIds: readonly string[],
  policy: PriorityPolicy = PriorityPolicy.FIFO_GLOBAL,
): CounterRoutingRule {
  return CounterRoutingRule.create(
    Identifier.generate(),
    counterId,
    `Counter ${counterId}`,
    categoryIds,
    policy,
  );
}

describe('GetQueueSnapshotUseCase (caller workspace load — QUE-19)', () => {
  let queue: InMemoryQueueRepository;
  let routingRules: InMemoryCounterRoutingRuleRepository;
  let useCase: GetQueueSnapshotUseCase;

  beforeEach(() => {
    queue = new InMemoryQueueRepository();
    routingRules = new InMemoryCounterRoutingRuleRepository();
    useCase = new GetQueueSnapshotUseCase(queue, routingRules);
  });

  it('returns the active ticket(s) at the counter and the waiting queue for its assigned categories', async () => {
    await routingRules.save(rule(1, ['CAT-A', 'CAT-B']));
    await queue.save(active('CAT-A', 'A', 1, 1, 'CALLING', 100));
    await queue.save(waiting('CAT-A', 'A', 2, 200));
    await queue.save(waiting('CAT-B', 'B', 1, 50)); // oldest waiting
    await queue.save(waiting('CAT-B', 'B', 2, 300));

    const snapshot = await useCase.execute({ counterId: 1 });

    expect(snapshot.counterId).toBe(1);
    expect(snapshot.active).toEqual([
      { ticketId: expect.any(String), ticketNumber: 'A-001', categoryId: 'CAT-A', status: 'CALLING', counterId: 1 },
    ]);
    // Waiting ordered oldest first (FIFO by createdAt) across assigned categories.
    expect(snapshot.waiting.map((t) => t.ticketNumber)).toEqual(['B-001', 'A-002', 'B-002']);
    expect(snapshot.waitingCount).toBe(3);
  });

  it('excludes waiting tickets whose category is not assigned to the counter', async () => {
    await routingRules.save(rule(1, ['CAT-A']));
    await queue.save(waiting('CAT-A', 'A', 1, 100));
    await queue.save(waiting('CAT-C', 'C', 9, 10)); // unassigned, even though older

    const snapshot = await useCase.execute({ counterId: 1 });

    expect(snapshot.waiting.map((t) => t.ticketNumber)).toEqual(['A-001']);
    expect(snapshot.waitingCount).toBe(1);
  });

  it('excludes active tickets belonging to a different counter', async () => {
    await routingRules.save(rule(1, ['CAT-A']));
    await queue.save(active('CAT-A', 'A', 1, 2, 'SERVING', 100)); // at counter 2
    await queue.save(waiting('CAT-A', 'A', 2, 200));

    const snapshot = await useCase.execute({ counterId: 1 });

    expect(snapshot.active).toEqual([]);
    expect(snapshot.waiting.map((t) => t.ticketNumber)).toEqual(['A-002']);
  });

  it('returns an empty (but well-formed) snapshot when the counter has no active or waiting tickets', async () => {
    await routingRules.save(rule(1, ['CAT-A']));

    const snapshot = await useCase.execute({ counterId: 1 });

    expect(snapshot).toEqual({
      counterId: 1,
      active: [],
      waiting: [],
      waitingCount: 0,
    });
  });

  it('throws EntityNotFoundException when the counter has no routing rule', async () => {
    await expect(useCase.execute({ counterId: 99 })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });
});