import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import { StateMachine } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { ReannounceTicketUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';
import { spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;

function callingTicket(counterId = 1): QueueTicket {
  const ticket = QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', 1),
    'CAT-A',
    FIXED_NOW,
  );
  ticket.markCalling(counterId, StateMachine.DEFAULT, FIXED_NOW + 1);
  return ticket;
}

describe('ReannounceTicketUseCase (Panggil Lagi — re-announce a CALLING ticket)', () => {
  const REANNOUNCE_NOW = FIXED_NOW + 100;
  const clock = () => REANNOUNCE_NOW;

  let queue: InMemoryQueueRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: ReannounceTicketUseCase;

  beforeEach(() => {
    queue = new InMemoryQueueRepository();
    dispatcher = spyDispatcher();
    // No policy resolver — reannounce performs no state transition.
    useCase = new ReannounceTicketUseCase(queue, dispatcher, clock);
  });

  it('re-announces a CALLING ticket, broadcasts TICKET_CALLED, and persists it (no state change)', async () => {
    const ticket = callingTicket(1);
    await queue.save(ticket);
    ticket.pullDomainEvents(); // drop events recorded by create/markCalling

    const result = await useCase.execute({ ticketId: ticket.id });

    expect(result.status).toBe('reannounced');
    expect(result.ticket.status).toBe(TicketStatus.CALLING);
    expect(result.ticket.ticketId).toBe(ticket.id.value);

    // The use case drained the re-emitted TICKET_CALLED via the dispatcher so
    // it broadcasts (FR-ENG-04). Dispatch is one call with the aggregate
    // regardless of event count.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);

    // No state change — still CALLING, counter retained.
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.counterId).toBe(1);
    // Only the TICKET_CALLED re-emit (no STATUS_UPDATED — no transition).
    const events = ticket.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('TICKET_CALLED');

    // Persisted — calledAt updated to the re-announce time.
    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe(TicketStatus.CALLING);
    expect(reloaded?.calledAt).toBe(REANNOUNCE_NOW);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(useCase.execute({ ticketId: ticketIdGenerate() })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException when reannouncing a non-CALLING ticket', async () => {
    // WAITING -> reannounce is invalid; reannounce is only valid from CALLING.
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      'CAT-A',
      FIXED_NOW,
    );
    await queue.save(ticket);
    ticket.pullDomainEvents(); // drop the creation event

    await expect(useCase.execute({ ticketId: ticket.id })).rejects.toBeInstanceOf(
      InvalidStateTransitionException,
    );
    // State unchanged; no NEW event recorded after the rejected re-announce.
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(ticket.pendingEventCount).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});