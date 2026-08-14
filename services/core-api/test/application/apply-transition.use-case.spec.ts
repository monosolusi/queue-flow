import { EntityNotFoundException } from '../../src/domain/shared/errors';
import {
  InvalidArgumentException,
  InvalidStateTransitionException,
} from '../../src/domain/shared/errors';
import { TransitionAction } from '../../src/domain/shared';
import { StateMachine, StateSchema, StateTransitionRule } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { ApplyTransitionUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;

/**
 * A custom state machine that adds an in-progress `PREPARING` state with a
 * `SERVING -> PREPARING` ("Siapkan Dokumen") edge — a manager-added step with no
 * canonical meaning — plus a `SERVING -> WAITING` re-queue. Includes the default
 * 5 states so the ticket can still reach SERVING.
 */
const CUSTOM_MACHINE = new StateMachine(
  StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'PREPARING', 'SKIPPED', 'COMPLETED']),
  [
    ['WAITING', 'CALLING', 'Panggil Berikutnya'],
    ['CALLING', 'SERVING', 'Mulai Melayani'],
    ['CALLING', 'SKIPPED', 'Lewati / Absen'],
    ['SKIPPED', 'CALLING', 'Panggil Ulang'],
    ['SERVING', 'PREPARING', 'Siapkan Dokumen'],
    ['PREPARING', 'COMPLETED', 'Selesai Layan'],
    ['SERVING', 'COMPLETED', 'Selesai Layan'],
    ['SERVING', 'WAITING', 'Kembalikan ke Antrian'],
  ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
);

/**
 * The same flow with one edge declared a category move. Used to prove this
 * command refuses it: the endpoints are identical to a plain re-queue, so only
 * the declaration separates the two.
 */
const TRANSFER_MACHINE = new StateMachine(
  StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
  [
    StateTransitionRule.of('WAITING', 'CALLING', 'Panggil Berikutnya'),
    StateTransitionRule.of('CALLING', 'SERVING', 'Mulai Melayani'),
    StateTransitionRule.of(
      'SERVING',
      'WAITING',
      'Pindah Kategori',
      TransitionAction.TRANSFER_CATEGORY,
    ),
  ],
);

/** A ticket in SERVING — the source state for the custom `Siapkan Dokumen` edge. */
function servingTicket(counterId = 1): QueueTicket {
  const ticket = QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', 1),
    'CAT-A',
    FIXED_NOW,
  );
  ticket.markCalling(counterId, CUSTOM_MACHINE, FIXED_NOW + 1);
  ticket.applyTransition('SERVING', CUSTOM_MACHINE, FIXED_NOW + 2);
  return ticket;
}

describe('ApplyTransitionUseCase (the single per-ticket transition command — FR-CLR-02)', () => {
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: ApplyTransitionUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    dispatcher = spyDispatcher();
    useCase = new ApplyTransitionUseCase(
      queue,
      fakePolicyResolver(CUSTOM_MACHINE),
      dispatcher,
      clock,
    );
  });

  it('applies a custom SERVING -> PREPARING transition, broadcasts STATUS_UPDATED, and persists it', async () => {
    const ticket = servingTicket(2);
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id, targetStatus: 'PREPARING' });

    expect(result.status).toBe('transitioned');
    expect(result.ticket.status).toBe('PREPARING');
    // A plain status change preserves the counter — the ticket is still being
    // served at the same counter, just in a custom in-progress sub-state.
    expect(result.ticket.counterId).toBe(2);
    expect(result.ticket.categoryId).toBe('CAT-A');

    // The use case drained the recorded TicketStatusChangedEvent via the
    // dispatcher so it broadcasts (FR-ENG-04).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);

    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe('PREPARING');
    // A CUSTOM target carries no canonical side effect, so the lifecycle stamps
    // are untouched: servedAt keeps the value SERVING set, and PREPARING adds
    // nothing of its own.
    expect(reloaded?.servedAt).toBe(FIXED_NOW + 2);
    expect(reloaded?.completedAt).toBeNull();
  });

  it('is idempotent when the target status equals the current status', async () => {
    const ticket = servingTicket(1);
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id, targetStatus: 'SERVING' });

    expect(result.status).toBe('transitioned');
    expect(result.ticket.status).toBe('SERVING');
    // transitionTo is a no-op when from === target, so the aggregate records no
    // event — `dispatch` is still called once (the use case always invokes it
    // after `save`) but drains nothing.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(
      useCase.execute({ ticketId: ticketIdGenerate(), targetStatus: 'PREPARING' }),
    ).rejects.toBeInstanceOf(EntityNotFoundException);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException when the edge is not configured', async () => {
    // PREPARING has no -> SKIPPED edge in CUSTOM_MACHINE.
    const ticket = servingTicket(1);
    ticket.applyTransition('PREPARING', CUSTOM_MACHINE, FIXED_NOW + 3);
    await queue.save(ticket);

    await expect(
      useCase.execute({ ticketId: ticket.id, targetStatus: TicketStatus.SKIPPED }),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    expect(ticket.currentStatus).toBe('PREPARING');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException under the default state machine (no custom edge)', async () => {
    // The PRD §7 default machine has no SERVING -> PREPARING edge. Accepting any
    // target the flow allows is not the same as accepting any target at all.
    useCase = new ApplyTransitionUseCase(
      queue,
      fakePolicyResolver(StateMachine.DEFAULT),
      dispatcher,
      clock,
    );
    const ticket = servingTicket(1);
    await queue.save(ticket);

    await expect(
      useCase.execute({ ticketId: ticket.id, targetStatus: 'PREPARING' }),
    ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  describe('canonical targets go through this same command', () => {
    // Each of these used to have its own endpoint, and something upstream had to
    // decide which one a given edge needed. The side effects belong to the target
    // state, so they arrive whichever edge leads there.
    it('stamps completedAt on a transition into COMPLETED', async () => {
      const ticket = servingTicket(1);
      await queue.save(ticket);

      const result = await useCase.execute({
        ticketId: ticket.id,
        targetStatus: TicketStatus.COMPLETED,
      });

      expect(result.ticket.status).toBe('COMPLETED');
      expect((await queue.findById(ticket.id))?.completedAt).toBe(FIXED_NOW + 10);
    });

    it('keeps the counter on a transition into SKIPPED, so the ticket stays in its bucket', async () => {
      const ticket = QueueTicket.create(
        ticketIdGenerate(),
        TicketNumber.of('A', 2),
        'CAT-A',
        FIXED_NOW,
      );
      ticket.markCalling(3, CUSTOM_MACHINE, FIXED_NOW + 1);
      await queue.save(ticket);

      const result = await useCase.execute({
        ticketId: ticket.id,
        targetStatus: TicketStatus.SKIPPED,
      });

      expect(result.ticket.status).toBe('SKIPPED');
      expect(result.ticket.counterId).toBe(3);
    });

    it('puts a ticket back in the queue on a transition into WAITING', async () => {
      // The manager's reported scenario: an edge into WAITING is a re-queue, not
      // a category move. The ticket keeps its number and its category.
      const ticket = servingTicket(2);
      await queue.save(ticket);

      const result = await useCase.execute({
        ticketId: ticket.id,
        targetStatus: TicketStatus.WAITING,
      });

      expect(result.ticket.status).toBe('WAITING');
      expect(result.ticket.counterId).toBeNull();
      expect(result.ticket.categoryId).toBe('CAT-A');
      expect(result.ticket.ticketNumber).toBe('A-001');
      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.calledAt).toBeNull();
      expect(reloaded?.servedAt).toBeNull();
    });

    it('announces at the counter that ran the command on a transition into CALLING', async () => {
      const ticket = QueueTicket.create(
        ticketIdGenerate(),
        TicketNumber.of('A', 3),
        'CAT-A',
        FIXED_NOW,
      );
      await queue.save(ticket);

      const result = await useCase.execute({
        ticketId: ticket.id,
        targetStatus: TicketStatus.CALLING,
        counterId: 5,
      });

      expect(result.ticket.status).toBe('CALLING');
      expect(result.ticket.counterId).toBe(5);
      expect((await queue.findById(ticket.id))?.calledAt).toBe(FIXED_NOW + 10);
    });

    it('rejects a transition into CALLING with no counter to announce at', async () => {
      const ticket = QueueTicket.create(
        ticketIdGenerate(),
        TicketNumber.of('A', 4),
        'CAT-A',
        FIXED_NOW,
      );
      await queue.save(ticket);

      await expect(
        useCase.execute({ ticketId: ticket.id, targetStatus: TicketStatus.CALLING }),
      ).rejects.toBeInstanceOf(InvalidArgumentException);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  it('refuses an edge the manager declared a category move', async () => {
    // Running it here would advance the status and silently skip the category
    // reassignment + re-issued number the manager configured — the harder half of
    // the action, missing, with nothing failing.
    const transferUseCase = new ApplyTransitionUseCase(
      queue,
      fakePolicyResolver(TRANSFER_MACHINE),
      dispatcher,
      clock,
    );
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 5),
      'CAT-A',
      FIXED_NOW,
    );
    ticket.markCalling(1, TRANSFER_MACHINE, FIXED_NOW + 1);
    ticket.applyTransition('SERVING', TRANSFER_MACHINE, FIXED_NOW + 2);
    await queue.save(ticket);

    await expect(
      transferUseCase.execute({ ticketId: ticket.id, targetStatus: TicketStatus.WAITING }),
    ).rejects.toBeInstanceOf(InvalidArgumentException);
    expect((await queue.findById(ticket.id))?.currentStatus).toBe('SERVING');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});