import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import { StateMachine } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { CompleteTicketUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;

/** A ticket in SERVING — the only state from which complete (Selesai Layan) is valid. */
function servingTicket(counterId = 1): QueueTicket {
  const ticket = QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', 1),
    'CAT-A',
    FIXED_NOW,
  );
  ticket.markCalling(counterId, StateMachine.DEFAULT, FIXED_NOW + 1);
  ticket.startServing(StateMachine.DEFAULT, FIXED_NOW + 2);
  return ticket;
}

describe('CompleteTicketUseCase (Selesai Layan — FR-CLR-03)', () => {
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: CompleteTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    dispatcher = spyDispatcher();
    useCase = new CompleteTicketUseCase(queue, fakePolicyResolver(), dispatcher, clock);
  });

  it('completes a SERVING ticket (SERVING -> COMPLETED), broadcasts STATUS_UPDATED, and persists it', async () => {
    const ticket = servingTicket(1);
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id });

    expect(result.status).toBe('completed');
    expect(result.ticket.status).toBe(TicketStatus.COMPLETED);

    // The use case drained the recorded TicketStatusChangedEvent via the
    // dispatcher so it broadcasts (FR-ENG-04).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);

    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe(TicketStatus.COMPLETED);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(useCase.execute({ ticketId: ticketIdGenerate() })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException when completing a CALLING ticket', async () => {
    // CALLING -> COMPLETED is not an edge; must go via SERVING first.
    const calling = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      'CAT-A',
      FIXED_NOW,
    );
    calling.markCalling(1, StateMachine.DEFAULT, FIXED_NOW + 1);
    await queue.save(calling);

    await expect(useCase.execute({ ticketId: calling.id })).rejects.toBeInstanceOf(
      InvalidStateTransitionException,
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});