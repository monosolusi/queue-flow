import { Identifier, NoOpTransactionManager } from '../../src/domain/shared';
import {
  EntityNotFoundException,
  InvalidArgumentException,
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
import { TransitionAction } from '../../src/domain/shared';
import { TransferTicketUseCase } from '../../src/application/queue';
import {
  InMemoryCategoryRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
} from '../../src/infrastructure/persistence/in-memory';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;
const DATE_KEY = '2026-07-30';

/** The PRD §7 default edges, as `[from, to, actionLabel]` triples. */
const DEFAULT_EDGES: readonly (readonly [string, string, string])[] = [
  ['WAITING', 'CALLING', 'Panggil Berikutnya'],
  ['CALLING', 'SERVING', 'Mulai Melayani'],
  ['CALLING', 'SKIPPED', 'Lewati / Absen'],
  ['SKIPPED', 'CALLING', 'Panggil Ulang'],
  ['SERVING', 'COMPLETED', 'Selesai Layan'],
];

/** A flow whose `CALLING -> WAITING` edge carries `action`. */
function callingToWaiting(action: TransitionAction): StateMachine {
  return new StateMachine(
    StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
    [
      ...DEFAULT_EDGES.map((e) => StateTransitionRule.of(e[0], e[1], e[2])),
      StateTransitionRule.of('CALLING', 'WAITING', 'Pindah Kategori', action),
    ],
  );
}

/**
 * A state machine with a configurable `CALLING -> WAITING` edge **declared a
 * category move** added to the PRD §7 default — what the designer writes when
 * the manager picks "Pindah Kategori" as that edge's action (FR-CLR-03). Drawing
 * the edge is not enough: the same pair left on the default `UPDATE_STATUS` is a
 * plain re-queue, which is the whole point of the declaration.
 */
const transferPolicy = callingToWaiting(TransitionAction.TRANSFER_CATEGORY);

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
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: TransferTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    categories = new InMemoryCategoryRepository();
    sequences = new InMemorySequenceRepository();
    dispatcher = spyDispatcher();
    useCase = new TransferTicketUseCase(
      queue,
      categories,
      sequences,
      fakePolicyResolver(transferPolicy),
      dispatcher,
      clock,
    );
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

  it('records STATUS_UPDATED and TICKET_TRANSFERRED events on the aggregate and forwards them to the dispatcher', async () => {
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
    // The use case forwarded the aggregate to the dispatcher so the events
    // broadcast (FR-ENG-04).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);
  });

  it('throws InvalidStateTransitionException (default machine has no transfer edge) and burns no sequence number', async () => {
    const sequencesSpy = new InMemorySequenceRepository();
    const useCaseDefault = new TransferTicketUseCase(
      queue,
      categories,
      sequencesSpy,
      fakePolicyResolver(StateMachine.DEFAULT), // no CALLING -> WAITING edge
      dispatcher,
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
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('refuses an edge the manager did not declare a category move, and burns no sequence number', async () => {
    // The reported defect in reverse: `CALLING -> WAITING` exists and is legal,
    // but the manager drew it to put a ticket back in the queue. Executing it as a
    // category move would re-issue the ticket's number under a category nobody
    // asked for — so the edge's own declaration, not its endpoints, decides.
    const sequencesSpy = new InMemorySequenceRepository();
    const useCaseRequeue = new TransferTicketUseCase(
      queue,
      categories,
      sequencesSpy,
      fakePolicyResolver(callingToWaiting(TransitionAction.UPDATE_STATUS)),
      dispatcher,
      clock,
    );
    const ticket = callingTicket();
    await queue.save(ticket);
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');

    await expect(
      useCaseRequeue.execute({
        ticketId: ticket.id,
        targetCategoryId: catB.id.value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);

    expect(await sequencesSpy.currentSequence(catB.id.value, DATE_KEY)).toBe(0);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.categoryId).toBe('CAT-A');
    expect(ticket.ticketNumber.formatted()).toBe('A-001');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a transfer along an edge whose target is not WAITING', () => {
    // Unreachable through the designer or the config API — a `TRANSFER_CATEGORY`
    // edge that targets anything else is rejected at save time, because a
    // re-issued per-category number describes a ticket nobody has served. Pinned
    // here so the aggregate's own contract is the one that holds if a flow ever
    // arrives from another path.
    const machine = new StateMachine(
      StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED', 'PREPARING']),
      [
        ...DEFAULT_EDGES.map((e) => StateTransitionRule.of(e[0], e[1], e[2])),
        StateTransitionRule.of(
          'CALLING',
          'PREPARING',
          'Pindah Kategori',
          TransitionAction.TRANSFER_CATEGORY,
        ),
      ],
    );
    const ticket = callingTicket();

    // The aggregate transitions to WAITING regardless of what the edge targets,
    // and this flow has no `CALLING -> WAITING` edge, so it refuses outright.
    expect(() =>
      ticket.transferTo('CAT-B', TicketNumber.of('B', 1), machine, FIXED_NOW + 1),
    ).toThrow(InvalidStateTransitionException);
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

  it('rejects a transfer to the ticket current category (no-op move) and burns no sequence (NFR-REL-02)', async () => {
    const catA = await seedCategory(categories, 'A', 'Loket Umum');
    // A CALLING ticket under CAT-A — but seedCategory mints a fresh UUID, so
    // reassign the ticket's categoryId to that UUID to simulate "same category".
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      catA.id.value,
      FIXED_NOW,
    );
    ticket.markCalling(1, transferPolicy, FIXED_NOW + 1);
    await queue.save(ticket);

    await expect(
      useCase.execute({
        ticketId: ticket.id,
        targetCategoryId: catA.id.value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);

    // No per-category number burned for the no-op move.
    expect(await sequences.currentSequence(catA.id.value, DATE_KEY)).toBe(0);
    // The ticket is unchanged.
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.categoryId).toBe(catA.id.value);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('runs sequence reservation + transfer + save inside one transaction and never broadcasts on rollback (NFR-REL-02)', async () => {
    const catB = await seedCategory(categories, 'B', 'Kasir & Pembayaran');
    const ticket = callingTicket();
    await queue.save(ticket);

    const txManager = new NoOpTransactionManager();
    const txSpy = jest.spyOn(txManager, 'runInTransaction');
    const txUseCase = new TransferTicketUseCase(
      queue,
      categories,
      sequences,
      fakePolicyResolver(transferPolicy),
      dispatcher,
      clock,
      txManager,
    );

    const result = await txUseCase.execute({
      ticketId: ticket.id,
      targetCategoryId: catB.id.value,
      dateKey: DATE_KEY,
    });

    // The reserve + mutate + save ran inside exactly one tx callback.
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('transferred');

    // Now force the tx body to roll back (save throws) and assert the
    // TICKET_TRANSFERRED / STATUS_UPDATED events are never broadcast — a
    // rolled-back transfer must not leak to realtime consumers.
    const rollbackQueue = new InMemoryQueueRepository();
    const failingTicket = callingTicket();
    await rollbackQueue.save(failingTicket);
    const saveSpy = jest.spyOn(rollbackQueue, 'save').mockRejectedValueOnce(
      new Error('tx rolled back'),
    );
    const rollbackUseCase = new TransferTicketUseCase(
      rollbackQueue,
      categories,
      sequences,
      fakePolicyResolver(transferPolicy),
      dispatcher,
      clock,
      txManager,
    );

    await expect(
      rollbackUseCase.execute({
        ticketId: failingTicket.id,
        targetCategoryId: catB.id.value,
        dateKey: DATE_KEY,
      }),
    ).rejects.toThrow('tx rolled back');

    // The dispatcher is never reached when the tx body throws (broadcast is
    // after commit). The single dispatch recorded above belongs to the
    // successful transfer, not this rollback.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});