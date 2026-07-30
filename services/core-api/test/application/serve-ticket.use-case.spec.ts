import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import { StateMachine } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { ServeTicketUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';

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

describe('ServeTicketUseCase (Mulai Melayani — FR-CLR-03)', () => {
  const transitionPolicy = StateMachine.DEFAULT;
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let useCase: ServeTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    useCase = new ServeTicketUseCase(queue, transitionPolicy, clock);
  });

  it('starts serving a CALLING ticket (CALLING -> SERVING) and persists it', async () => {
    const ticket = callingTicket(1);
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id });

    expect(result.status).toBe('serving');
    expect(result.ticket.status).toBe(TicketStatus.SERVING);

    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe(TicketStatus.SERVING);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(useCase.execute({ ticketId: ticketIdGenerate() })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('throws InvalidStateTransitionException when serving a WAITING ticket', async () => {
    const ticket = QueueTicket.create(
      ticketIdGenerate(),
      TicketNumber.of('A', 1),
      'CAT-A',
      FIXED_NOW,
    );
    await queue.save(ticket);

    await expect(useCase.execute({ ticketId: ticket.id })).rejects.toBeInstanceOf(
      InvalidStateTransitionException,
    );
  });
});