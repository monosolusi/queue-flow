import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import {
  QueueTicket,
  TicketNumber,
  TicketStatus,
  ticketIdGenerate,
} from '../../src/domain/queue';
import { StateMachine } from '../../src/domain/store-config';
import {
  TicketCalledEvent,
  TicketCreatedEvent,
  TicketStatusChangedEvent,
} from '../../src/domain/queue';

const FIXED_NOW = 1_700_000_000_000;

function newTicket(categoryId = 'CAT-A'): QueueTicket {
  return QueueTicket.create(
    ticketIdGenerate(),
    TicketNumber.of('A', 1),
    categoryId,
    FIXED_NOW,
  );
}

describe('QueueTicket aggregate', () => {
  const policy = StateMachine.DEFAULT;

  it('is created in WAITING and records a TicketCreatedEvent', () => {
    const ticket = newTicket();
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(ticket.counterId).toBeNull();
    const events = ticket.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(TicketCreatedEvent);
    expect(events[0].type).toBe('TICKET_CREATED');
  });

  it('transitions WAITING -> CALLING and emits Called + StatusChanged events', () => {
    const ticket = newTicket();
    ticket.pullDomainEvents(); // drop the creation event to isolate this transition
    ticket.markCalling(2, policy, FIXED_NOW + 1);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.counterId).toBe(2);
    const events = ticket.pullDomainEvents();
    expect(events.map((e) => e.type)).toEqual(['STATUS_UPDATED', 'TICKET_CALLED']);
    expect(events[0]).toBeInstanceOf(TicketStatusChangedEvent);
    expect((events[0] as TicketStatusChangedEvent).actionLabel).toBe('Panggil Berikutnya');
    expect(events[1]).toBeInstanceOf(TicketCalledEvent);
    expect((events[1] as TicketCalledEvent).counterId).toBe(2);
  });

  it('walks the full happy path: CALLING -> SERVING -> COMPLETED', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.startServing(policy, FIXED_NOW + 1);
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
    ticket.complete(policy, FIXED_NOW + 2);
    expect(ticket.currentStatus).toBe(TicketStatus.COMPLETED);
  });

  it('supports skip then recall (Panggil Ulang)', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.skip(policy, FIXED_NOW + 1);
    expect(ticket.currentStatus).toBe(TicketStatus.SKIPPED);
    ticket.recall(policy, FIXED_NOW + 2);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
  });

  it('throws InvalidStateTransitionException on illegal transitions', () => {
    const ticket = newTicket();
    ticket.pullDomainEvents(); // drop the creation event first
    expect(() => ticket.startServing(policy, FIXED_NOW)).toThrow(
      InvalidStateTransitionException,
    );
    // state must be unchanged and no event recorded after a rejected transition
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(ticket.pendingEventCount).toBe(0);
  });

  it('cannot skip directly from WAITING (no WAITING -> SKIPPED edge)', () => {
    const ticket = newTicket();
    expect(() => ticket.skip(policy, FIXED_NOW)).toThrow(
      InvalidStateTransitionException,
    );
  });

  it('recall is only valid from SKIPPED (rejects recall from WAITING)', () => {
    const ticket = newTicket();
    expect(() => ticket.recall(policy, FIXED_NOW)).toThrow(
      InvalidStateTransitionException,
    );
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
  });

  it('markCalling is a no-op when already CALLING (no counter change, no event)', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.pullDomainEvents();
    ticket.markCalling(2, policy, FIXED_NOW + 1); // already CALLING
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    expect(ticket.counterId).toBe(1); // unchanged
    expect(ticket.pendingEventCount).toBe(0);
  });

  it('is idempotent when transitioning to the same status (no event)', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.startServing(policy, FIXED_NOW + 1);
    ticket.pullDomainEvents(); // clear all pending events
    ticket.startServing(policy, FIXED_NOW + 2); // SERVING -> SERVING (no-op)
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
    expect(ticket.pendingEventCount).toBe(0);
  });

  it('pullDomainEvents clears the queue', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    expect(ticket.pullDomainEvents().length).toBeGreaterThan(0);
    expect(ticket.pullDomainEvents()).toHaveLength(0);
  });
});