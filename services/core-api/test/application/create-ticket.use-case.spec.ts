import { Identifier, type DomainEvent } from '../../src/domain/shared';
import { EntityNotFoundException } from '../../src/domain/shared/errors';
import {
  Category,
  TicketStatus,
} from '../../src/domain/queue';
import { CreateTicketUseCase, toDateKey } from '../../src/application/queue';
import { QueueEventDispatcher } from '../../src/application/queue/queue-event-dispatcher';
import {
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
} from '../../src/infrastructure/persistence/in-memory';

const FIXED_NOW = 1_700_000_000_000; // a stable epoch the tests pin the clock to

/** A real {@link QueueEventDispatcher} wired to a publisher that captures events. */
function capturingDispatcher(): { dispatcher: QueueEventDispatcher; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  const dispatcher = new QueueEventDispatcher({
    publish: async (e) => {
      events.push(...e);
    },
  });
  return { dispatcher, events };
}

async function seedCategory(
  repo: InMemoryCategoryRepository,
  code: string,
  name = code,
): Promise<Category> {
  const cat = new Category(Identifier.generate(), code, name);
  await repo.save(cat);
  return cat;
}

describe('CreateTicketUseCase (ticket generation — FR-ENG-01 / QUE-9)', () => {
  let now = FIXED_NOW;
  const clock = () => now;

  let queue: InMemoryQueueRepository;
  let categories: InMemoryCategoryRepository;
  let sequences: InMemorySequenceRepository;
  let captured: { dispatcher: QueueEventDispatcher; events: DomainEvent[] };
  let useCase: CreateTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    categories = new InMemoryCategoryRepository();
    sequences = new InMemorySequenceRepository();
    captured = capturingDispatcher();
    useCase = new CreateTicketUseCase(queue, categories, sequences, captured.dispatcher, clock);
  });

  it('mints an A-001 formatted ticket and persists it in WAITING', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');

    const result = await useCase.execute({ categoryId: catA.id.value });

    expect(result.status).toBe('created');
    expect(result.ticket.ticketNumber).toBe('A-001');
    expect(result.ticket.categoryId).toBe(catA.id.value);
    expect(result.ticket.status).toBe(TicketStatus.WAITING);

    // Persisted in WAITING with the same formatted number.
    const waiting = await queue.findWaitingByCategory(catA.id.value);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].ticketNumber.formatted()).toBe('A-001');
    expect(waiting[0].currentStatus).toBe(TicketStatus.WAITING);
  });

  it('advances the per-category sequence per ticket (A-001, then A-002)', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');

    const r1 = await useCase.execute({ categoryId: catA.id.value });
    const r2 = await useCase.execute({ categoryId: catA.id.value });

    expect(r1.ticket.ticketNumber).toBe('A-001');
    expect(r2.ticket.ticketNumber).toBe('A-002');
    expect(await sequences.currentSequence(catA.id.value, toDateKey(now))).toBe(2);
  });

  it('isolates the sequence per category (A-001 and B-001 are independent)', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    const ra = await useCase.execute({ categoryId: catA.id.value });
    const rb = await useCase.execute({ categoryId: catB.id.value });

    expect(ra.ticket.ticketNumber).toBe('A-001');
    expect(rb.ticket.ticketNumber).toBe('B-001');
  });

  it('isolates the sequence per day (a new local day restarts at A-001)', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');

    const r1 = await useCase.execute({ categoryId: catA.id.value });
    expect(r1.ticket.ticketNumber).toBe('A-001');

    // Advance the clock ~30 days — guaranteed a different local calendar date
    // regardless of the host timezone / DST, so the date key changes.
    now += 30 * 86_400_000;
    const r2 = await useCase.execute({ categoryId: catA.id.value });
    expect(r2.ticket.ticketNumber).toBe('A-001');
  });

  it('broadcasts exactly one TICKET_CREATED event after save (FR-ENG-04)', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');

    await useCase.execute({ categoryId: catA.id.value });

    expect(captured.events.map((e) => e.type)).toEqual(['TICKET_CREATED']);
    const waiting = await queue.findWaitingByCategory(catA.id.value);
    expect(captured.events[0].aggregateId).toBe(waiting[0].id.value);
  });

  it('throws EntityNotFoundException when the category does not exist', async () => {
    await expect(
      useCase.execute({ categoryId: Identifier.generate().value }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('never repeats a number across use-case instances sharing the sequence store (restart-safe)', async () => {
    const catA = await seedCategory(categories, 'A', 'Customer Service');

    // First "process" issues A-001 / A-002.
    await useCase.execute({ categoryId: catA.id.value });
    await useCase.execute({ categoryId: catA.id.value });

    // Simulate a service restart: a fresh use-case instance backed by the SAME
    // sequence store (the durable part — a Postgres+WAL impl survives a crash;
    // the in-memory store stands in for it here). The next number must continue
    // the sequence, not restart from 1 (NFR-REL-02).
    const restarted = new CreateTicketUseCase(
      queue,
      categories,
      sequences, // same store survives the "restart"
      capturingDispatcher().dispatcher,
      clock,
    );
    const r = await restarted.execute({ categoryId: catA.id.value });

    expect(r.ticket.ticketNumber).toBe('A-003');
  });
});