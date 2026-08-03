import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
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
 * `SERVING -> PREPARING` ("Siapkan Dokumen") edge — exactly the wizard-configured
 * transition QUE-33 exists to back. Includes the default 5 states so the ticket
 * can still reach SERVING.
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
  ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
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
  ticket.startServing(CUSTOM_MACHINE, FIXED_NOW + 2);
  return ticket;
}

describe('ApplyTransitionUseCase (generic apply-transition — QUE-33, FR-CLR-02)', () => {
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
    // The generic transition owns no lifecycle-timestamp side effect: servedAt
    // is unchanged (still set), and the custom PREPARING state does not touch
    // calledAt/servedAt/completedAt.
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
    // The PRD §7 default machine has no SERVING -> PREPARING edge → the generic
    // endpoint rejects exactly like the six fixed commands would.
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
});