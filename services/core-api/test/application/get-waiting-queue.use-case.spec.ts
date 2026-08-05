import {
  QueueTicket,
  TicketNumber,
  ticketIdGenerate,
  type TicketId,
} from '../../src/domain/queue';
import { GetWaitingQueueUseCase } from '../../src/application/queue';
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
): QueueTicket {
  return QueueTicket.reconstitute({
    id: ticketIdGenerate() as TicketId,
    ticketNumber: TicketNumber.of(code, seq),
    categoryId,
    status,
    counterId,
    createdAt,
    updatedAt: createdAt,
    calledAt: status === 'CALLING' || status === 'SERVING' ? createdAt : null,
    servedAt: status === 'SERVING' ? createdAt : null,
    completedAt: null,
  });
}

describe('GetWaitingQueueUseCase (TV board global waiting read)', () => {
  let queue: InMemoryQueueRepository;
  let useCase: GetWaitingQueueUseCase;

  beforeEach(() => {
    queue = new InMemoryQueueRepository();
    useCase = new GetWaitingQueueUseCase(queue);
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

  it('excludes non-WAITING tickets (CALLING / SERVING / COMPLETED / SKIPPED)', async () => {
    await queue.save(waiting('CAT-A', 'A', 1, 100));
    await queue.save(active('CAT-A', 'A', 2, 1, 'CALLING', 50));
    await queue.save(active('CAT-A', 'A', 3, 1, 'SERVING', 75));
    await queue.save(waiting('CAT-B', 'B', 1, 150));

    const result = await useCase.execute();

    expect(result.waiting.map((t) => t.ticketNumber)).toEqual(['A-001', 'B-001']);
    expect(result.waitingCount).toBe(2);
  });

  it('returns an empty list when no tickets are WAITING', async () => {
    await queue.save(active('CAT-A', 'A', 1, 1, 'CALLING', 50));

    const result = await useCase.execute();

    expect(result).toEqual({ waiting: [], waitingCount: 0 });
  });

  it('returns an empty list when the store is empty', async () => {
    const result = await useCase.execute();

    expect(result).toEqual({ waiting: [], waitingCount: 0 });
  });
});