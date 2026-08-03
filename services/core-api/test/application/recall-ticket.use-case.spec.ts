import { EntityNotFoundException } from '../../src/domain/shared/errors';
import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import { StateMachine } from '../../src/domain/store-config';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { RecallTicketUseCase } from '../../src/application/queue';
import { InMemoryQueueRepository } from '../../src/infrastructure/persistence/in-memory';
import { fakePolicyResolver, spyDispatcher } from './test-doubles';

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

/** A ticket in SKIPPED — the only state from which recall (Panggil Ulang) is valid. */
function skippedTicket(): QueueTicket {
  const ticket = callingTicket(1);
  ticket.skip(StateMachine.DEFAULT, FIXED_NOW + 2);
  return ticket;
}

describe('RecallTicketUseCase (Panggil Ulang — FR-CLR-03)', () => {
  let now = FIXED_NOW;
  const clock = () => (now += 10);

  let queue: InMemoryQueueRepository;
  let dispatcher: ReturnType<typeof spyDispatcher>;
  let useCase: RecallTicketUseCase;

  beforeEach(() => {
    now = FIXED_NOW;
    queue = new InMemoryQueueRepository();
    dispatcher = spyDispatcher();
    useCase = new RecallTicketUseCase(queue, fakePolicyResolver(), dispatcher, clock);
  });

  it('recalls a SKIPPED ticket back to CALLING, broadcasts STATUS_UPDATED, and persists it', async () => {
    const ticket = skippedTicket();
    await queue.save(ticket);

    const result = await useCase.execute({ ticketId: ticket.id });

    expect(result.status).toBe('recalled');
    expect(result.ticket.status).toBe(TicketStatus.CALLING);
    expect(result.ticket.ticketId).toBe(ticket.id.value);

    // The use case drained the recorded events (STATUS_UPDATED +
    // TICKET_CALLED — recall is a re-call) via the dispatcher so they broadcast
    // (FR-ENG-04). Dispatch is one call with the aggregate regardless of event
    // count.
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(ticket);

    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    const reloaded = await queue.findById(ticket.id);
    expect(reloaded?.currentStatus).toBe(TicketStatus.CALLING);
  });

  it('throws EntityNotFoundException when the ticket does not exist', async () => {
    await expect(useCase.execute({ ticketId: ticketIdGenerate() })).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('throws InvalidStateTransitionException when recalling a non-skipped ticket', async () => {
    // CALLING -> CALLING is not a recall; recall is only valid from SKIPPED.
    const ticket = callingTicket(1);
    await queue.save(ticket);
    ticket.pullDomainEvents(); // drop events recorded by create/markCalling

    await expect(useCase.execute({ ticketId: ticket.id })).rejects.toBeInstanceOf(
      InvalidStateTransitionException,
    );
    // State unchanged; no NEW event recorded after the rejected transition.
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.pendingEventCount).toBe(0);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });
});