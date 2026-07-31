import { Identifier } from '../../src/domain/shared';
import { PriorityPolicy } from '../../src/domain/shared/priority-policy';
import {
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { CallNextTicketUseCase } from '../../src/application/queue';
import {
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { CounterRoutingRule } from '../../src/domain/store-config';
import { EntityNotFoundException } from '../../src/domain/shared';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

/** A WAITING ticket created at `createdAt` with category code `code` and `seq`. */
function waiting(categoryId: string, code: string, seq: number, createdAt: number): QueueTicket {
  return QueueTicket.create(ticketIdGenerate(), TicketNumber.of(code, seq), categoryId, createdAt);
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

describe('CallNextTicketUseCase (counter routing engine — FR-ENG-03)', () => {
  let now = 1_000;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let routingRules: InMemoryCounterRoutingRuleRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: CallNextTicketUseCase;

  beforeEach(() => {
    now = 1_000;
    queue = new InMemoryQueueRepository();
    routingRules = new InMemoryCounterRoutingRuleRepository();
    dispatcher = spyDispatcher();
    useCase = new CallNextTicketUseCase(
      routingRules,
      queue,
      fakePolicyResolver(),
      dispatcher,
      clock,
    );
  });

  it('FIFO_GLOBAL: picks the oldest WAITING ticket across all assigned categories', async () => {
    await routingRules.save(rule(1, ['CAT-A', 'CAT-B'], PriorityPolicy.FIFO_GLOBAL));
    await queue.save(waiting('CAT-A', 'A', 1, 100));
    await queue.save(waiting('CAT-B', 'B', 2, 50)); // oldest overall
    await queue.save(waiting('CAT-A', 'A', 3, 200));

    const result = await useCase.execute({ counterId: 1 });

    expect(result.status).toBe('called');
    if (result.status === 'called') {
      expect(result.ticket.ticketNumber).toBe('B-002');
      expect(result.ticket.categoryId).toBe('CAT-B');
      expect(result.ticket.counterId).toBe(1);
    }
  });

  it('CATEGORY_PRIORITY: prefers the first assigned category even when a later one is older', async () => {
    // Order [CAT-A, CAT-B] => CAT-A is higher priority.
    await routingRules.save(rule(1, ['CAT-A', 'CAT-B'], PriorityPolicy.CATEGORY_PRIORITY));
    await queue.save(waiting('CAT-B', 'B', 2, 50)); // older, lower-priority category
    await queue.save(waiting('CAT-A', 'A', 1, 100));

    const result = await useCase.execute({ counterId: 1 });

    expect(result.status).toBe('called');
    expect(result.status === 'called' && result.ticket.ticketNumber).toBe('A-001');
  });

  it('CATEGORY_PRIORITY: falls through to a lower-priority category when the higher one is empty', async () => {
    await routingRules.save(rule(1, ['CAT-A', 'CAT-B'], PriorityPolicy.CATEGORY_PRIORITY));
    await queue.save(waiting('CAT-B', 'B', 5, 300)); // only CAT-B has waiting tickets

    const result = await useCase.execute({ counterId: 1 });

    expect(result.status).toBe('called');
    expect(result.status === 'called' && result.ticket.ticketNumber).toBe('B-005');
  });

  it('only serves assigned categories — an older unassigned ticket is never picked', async () => {
    await routingRules.save(rule(1, ['CAT-A'], PriorityPolicy.FIFO_GLOBAL));
    await queue.save(waiting('CAT-C', 'C', 9, 10)); // oldest overall, but not assigned
    await queue.save(waiting('CAT-A', 'A', 1, 500));

    const result = await useCase.execute({ counterId: 1 });

    expect(result.status).toBe('called');
    expect(result.status === 'called' && result.ticket.ticketNumber).toBe('A-001');
  });

  it('returns empty when no WAITING ticket matches the routing', async () => {
    await routingRules.save(rule(1, ['CAT-A'], PriorityPolicy.FIFO_GLOBAL));
    await queue.save(waiting('CAT-B', 'B', 1, 100)); // not assigned to this counter

    const result = await useCase.execute({ counterId: 1 });

    expect(result).toEqual({ status: 'empty' });
  });

  it('throws EntityNotFoundException when the counter has no routing rule', async () => {
    await expect(useCase.execute({ counterId: 99 })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('transitions the selected ticket to CALLING, broadcasts a TicketCalledEvent, and persists it', async () => {
    await routingRules.save(rule(2, ['CAT-A'], PriorityPolicy.FIFO_GLOBAL));
    const ticket = waiting('CAT-A', 'A', 1, 100);
    await queue.save(ticket);

    const result = await useCase.execute({ counterId: 2 });
    expect(result.status).toBe('called');

    // The aggregate in memory moved to CALLING under counter 2.
    expect(ticket.currentStatus).toBe('CALLING');
    expect(ticket.counterId).toBe(2);

    // The use case forwarded the aggregate to the dispatcher so the recorded
    // TicketCalledEvent actually broadcasts (FR-ENG-04). The spy records the
    // call; the aggregate still holds the event (the real dispatcher drains it,
    // exercised in the realtime integration test).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);
    const events = ticket.pullDomainEvents();
    expect(events.some((e) => e.type === 'TICKET_CALLED')).toBe(true);

    // Persistence: reloaded copy from the repository reflects the same state.
    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe('CALLING');
    expect(reloaded?.counterId).toBe(2);
  });

  it('does not dispatch when the queue is empty for the counter', async () => {
    await routingRules.save(rule(1, ['CAT-A'], PriorityPolicy.FIFO_GLOBAL));

    const result = await useCase.execute({ counterId: 1 });

    expect(result).toEqual({ status: 'empty' });
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});