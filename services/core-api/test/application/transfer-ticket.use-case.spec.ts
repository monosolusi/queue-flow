import { Identifier } from '../../src/domain/shared';
import {
  EntityNotFoundException,
  InvalidStateTransitionException,
} from '../../src/domain/shared/errors';
import {
  Category,
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import {
  StateMachine,
  StateSchema,
  StateTransitionRule,
} from '../../src/domain/store-config';
import { TransferTicketUseCase } from '../../src/application/queue';
import {
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
} from '../../src/infrastructure/persistence/in-memory';

const FIXED_NOW = 1_700_000_000_000;
const DATE_KEY = '2026-07-30';

/**
 * A state machine with a configurable `CALLING -> WAITING` transfer edge
 * ("Pindah Kategori") added to the PRD §7 default — what the wizard/admin
 * configures to enable transfers (FR-CLR-03).
 */
const transferPolicy = new StateMachine(
  StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
  [
    ['WAITING', 'CALLING', 'Panggil Berikutnya'],
    ['CALLING', 'SERVING', 'Mulai Melayani'],
    ['CALLING', 'SKIPPED', 'Lewati / Absen'],
    ['SKIPPED', 'CALLING', 'Panggil Ulang'],
    ['SERVING', 'COMPLETED', 'Selesai Layan'],
    ['CALLING', 'WAITING', 'Pindah Kategori'],
  ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
);

/** A fresh category (random UUID id) with the given code/name, saved to the repo. */
async function seedCategory(
  repo: InMemoryCategoryRepository,
  code: string,
  name = code,
): Promise<Category> {
  const cat = new Category(Identifier.generate(), code, name);
  await repo.save(cat);
  return cat;
}

/** A CALLING ticket under CAT-A at counter 1. */
function callingTicket(): QueueTicket {
  const ticket = QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', 1),
    'CAT-A',
    FIXED_NOW,
  );
  ticket.markCalling(1, transferPolicy, FIXED_NOW + 1);
  return ticket;
}

describe('TransferTicketUseCase (pindah kategori — FR-CLR-03)', () => {
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let categories: InMemoryCategoryRepository;
  let sequences: InMemorySequenceRepository;
  let useCase: TransferTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    categories = new InMemoryCategoryRepository();
    sequences = new InMemorySequenceRepository();
    useCase = new TransferTicketUseCase(queue, categories, sequences, transferPolicy, clock);
  });

  it('reassigns the ticket to the target category, issues a new number, and returns it to WAITING', async () => {
    const ticket = callingTicket();
    await queue.save(ticket);
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    const result = await useCase.execute({
      ticketId: ticket.id,
      targetCategoryId: catB.id.value,
      dateKey: DATE_KEY,
    });

    expect(result.status).toBe('transferred');
    expect(result.ticket.categoryId).toBe(catB.id.value);
    expect(result.ticket.ticketNumber).toBe('B-001'); // first B number of the day
    expect(result.ticket.status).toBe(TicketStatus.WAITING);
    expect(result.ticket.counterId).toBeNull();
    expect(result.ticket.previousCategoryId).toBe('CAT-A');
    expect(result.ticket.previousTicketNumber).toBe('A-001');

    // The aggregate moved and persisted.
    expect(ticket.categoryId).toBe(catB.id.value);
    expect(ticket.ticketNumber.formatted()).toBe('B-001');
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(ticket.counterId).toBeNull();
    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.ticketNumber.formatted()).toBe('B-001');
  });

  it('records STATUS_UPDATED and TICKET_TRANSFERRED events on the aggregate', async () => {
    const ticket = callingTicket();
    await queue.save(ticket);
    ticket.pullDomainEvents(); // drop create/call events to isolate transfer
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    await useCase.execute({
      ticketId: ticket.id,
      targetCategoryId: catB.id.value,
      dateKey: DATE_KEY,
    });

    const events = ticket.pullDomainEvents();
    expect(events.map((e) => e.type)).toEqual(['STATUS_UPDATED', 'TICKET_TRANSFERRED']);
  });

  it('throws InvalidStateTransitionException (default machine has no transfer edge) and burns no sequence number', async () => {
    const sequencesSpy = new InMemorySequenceRepository();
    const useCaseDefault = new TransferTicketUseCase(
      queue,
      categories,
      sequencesSpy,
      StateMachine.DEFAULT, // no CALLING -> WAITING edge
      clock,
    );
    const ticket = callingTicket(); // CALLING under the transfer-enabled machine
    await queue.save(ticket);
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    await expect(
      useCaseDefault.execute({
        ticketId: ticket.id,
        targetCategoryId: catB.id.value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);

    // NFR-REL-02: an illegal transfer must not advance the per-category
    // sequence (no number burned / no gap).
    expect(await sequencesSpy.currentSequence(catB.id.value, DATE_KEY)).toBe(0);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.categoryId).toBe('CAT-A');
  });

  it('throws EntityNotFoundException when the target category does not exist', async () => {
    const ticket = callingTicket();
    await queue.save(ticket);

    await expect(
      useCase.execute({
        ticketId: ticket.id,
        targetCategoryId: Identifier.generate().value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    await expect(
      useCase.execute({
        ticketId: ticketIdGenerate(),
        targetCategoryId: catB.id.value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
  });

  it('advances the per-category sequence per transfer (B-001, then B-002)', async () => {
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');
    const first = callingTicket();
    const second = callingTicket();
    await queue.save(first);
    await queue.save(second);

    const r1 = await useCase.execute({
      ticketId: first.id,
      targetCategoryId: catB.id.value,
      dateKey: DATE_KEY,
    });
    const r2 = await useCase.execute({
      ticketId: second.id,
      targetCategoryId: catB.id.value,
      dateKey: DATE_KEY,
    });

    expect(r1.ticket.ticketNumber).toBe('B-001');
    expect(r2.ticket.ticketNumber).toBe('B-002');
  });
});