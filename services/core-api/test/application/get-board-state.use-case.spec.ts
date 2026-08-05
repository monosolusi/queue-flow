import {
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
  type TicketId,
} from '../../src/domain/queue';
import { GetBoardStateUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';

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
  updatedAt: number = createdAt,
): QueueTicket {
  return QueueTicket.reconstitute({
    id: ticketIdGenerate() as TicketId,
    ticketNumber: TicketNumber.of(code, seq),
    categoryId,
    status,
    counterId,
    createdAt,
    updatedAt,
    calledAt: status === 'CALLING' || status === 'SERVING' ? createdAt : null,
    servedAt: status === 'SERVING' ? createdAt : null,
    completedAt: null,
  });
}

describe('GetBoardStateUseCase (board active + waiting read)', () => {
  let queue: InMemoryQueueRepository;
  let useCase: GetBoardStateUseCase;

  beforeEach(() => {
    queue = new InMemoryQueueRepository();
    useCase = new GetBoardStateUseCase(queue);
  });

  it('returns all WAITING tickets across categories oldest first (FIFO by createdAt)', async () => {
    await queue.save(waiting('CAT-A', 'A', 2, 200));
    await queue.save(waiting('CAT-B', 'B', 1, 50)); // oldest
    await queue.save(waiting('CAT-A', 'A', 3, 300));
    await queue.save(waiting('CAT-B', 'B', 2, 100));

    const result = await useCase.execute();

    expect(result.waiting.map((t) => t.ticketNumber)).toEqual([
      'B-001',
      'B-002',
      'A-002',
      'A-003',
    ]);
    expect(result.waitingCount).toBe(4);
  });

  it('excludes non-WAITING tickets from waiting (CALLING / SERVING / COMPLETED / SKIPPED)', async () => {
    await queue.save(waiting('CAT-A', 'A', 1, 100));
    await queue.save(active('CAT-A', 'A', 2, 1, 'CALLING', 50));
    await queue.save(active('CAT-A', 'A', 3, 1, 'SERVING', 75));
    await queue.save(waiting('CAT-B', 'B', 1, 150));

    const result = await useCase.execute();

    expect(result.waiting.map((t) => t.ticketNumber)).toEqual(['A-001', 'B-001']);
    expect(result.waitingCount).toBe(2);
  });

  it('returns all CALLING/SERVING tickets across counters ordered by updatedAt asc', async () => {
    // Two active tickets at different counters; the one touched most recently
    // (largest updatedAt) must be last — that is the one the TV projects to
    // nowServing. A third active ticket with the smallest updatedAt is first.
    await queue.save(active('CAT-A', 'A', 2, 1, 'CALLING', 50, 500));
    await queue.save(active('CAT-B', 'B', 1, 2, 'SERVING', 75, 800));
    await queue.save(active('CAT-A', 'A', 3, 3, 'CALLING', 60, 300)); // oldest-updated
    await queue.save(waiting('CAT-A', 'A', 4, 100)); // ignored in active

    const result = await useCase.execute();

    expect(result.active.map((t) => t.ticketNumber)).toEqual([
      'A-003', // updatedAt 300
      'A-002', // updatedAt 500
      'B-001', // updatedAt 800
    ]);
    // Each active row carries its counterId (non-null for CALLING/SERVING).
    expect(result.active.map((t) => t.counterId)).toEqual([3, 1, 2]);
    // WAITING tickets are NOT in active.
    expect(result.active.find((t) => t.ticketNumber === 'A-004')).toBeUndefined();
  });

  it('excludes non-active tickets from active (WAITING / COMPLETED / SKIPPED)', async () => {
    await queue.save(waiting('CAT-A', 'A', 1, 100));
    await queue.save(active('CAT-A', 'A', 2, 1, 'CALLING', 50));
    // A COMPLETED ticket has counterId set but is NOT active.
    await queue.save(
      QueueTicket.reconstitute({
        id: ticketIdGenerate() as TicketId,
        ticketNumber: TicketNumber.of('A', 3),
        categoryId: 'CAT-A',
        status: 'COMPLETED',
        counterId: 1,
        createdAt: 10,
        updatedAt: 20,
        calledAt: 10,
        servedAt: 15,
        completedAt: 20,
      }),
    );

    const result = await useCase.execute();

    expect(result.active.map((t) => t.ticketNumber)).toEqual(['A-002']);
    expect(result.waiting.map((t) => t.ticketNumber)).toEqual(['A-001']);
  });

  it('returns an empty active+waiting list when no tickets are WAITING/active', async () => {
    await queue.save(
      QueueTicket.reconstitute({
        id: ticketIdGenerate() as TicketId,
        ticketNumber: TicketNumber.of('A', 1),
        categoryId: 'CAT-A',
        status: 'COMPLETED',
        counterId: 1,
        createdAt: 10,
        updatedAt: 20,
        calledAt: 10,
        servedAt: 15,
        completedAt: 20,
      }),
    );

    const result = await useCase.execute();

    expect(result).toEqual({ active: [], waiting: [], waitingCount: 0 });
  });

  it('returns an empty active+waiting list when the store is empty', async () => {
    const result = await useCase.execute();

    expect(result).toEqual({ active: [], waiting: [], waitingCount: 0 });
  });
});