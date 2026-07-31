import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import { StateMachine } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { SkipTicketUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

const FIXED_NOW = 1_700_000_000_000;

/** A ticket in CALLING — the only state from which skip (Lewati / Absen) is valid. */
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

describe('SkipTicketUseCase (Lewati / Absen — FR-CLR-03)', () => {
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: SkipTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    dispatcher = spyDispatcher();
    useCase = new SkipTicketUseCase(queue, fakePolicyResolver(), dispatcher, clock);
  });

  it('skips a CALLING ticket to SKIPPED, broadcasts STATUS_UPDATED, and persists it', async () => {
    const ticket = callingTicket(2);
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id });

    expect(result.status).toBe('skipped');
    expect(result.ticket.status).toBe(TicketStatus.SKIPPED);
    expect(result.ticket.counterId).toBe(2);

    // The use case drained the recorded TicketStatusChangedEvent via the
    // dispatcher so it broadcasts (FR-ENG-04).
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);

    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe(TicketStatus.SKIPPED);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(useCase.execute({ ticketId: ticketIdGenerate() })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException when skipping a non-calling ticket', async () => {
    // A fresh WAITING ticket has no WAITING -> SKIPPED edge.
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
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});