import { InvalidStateTransitionException } from '../../src/domain/shared/errors';
import {
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
import {
  TicketCalledEvent,
  TicketCreatedEvent,
  TicketStatusChangedEvent,
  TicketTransferredEvent,
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

  it('supports skip then recall (Panggil Ulang) and re-emits TICKET_CALLED', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.pullDomainEvents(); // drop the call events to isolate the recall
    ticket.skip(policy, FIXED_NOW + 1);
    ticket.pullDomainEvents(); // drop the skip STATUS_UPDATED
    expect(ticket.currentStatus).toBe(TicketStatus.SKIPPED);
    ticket.recall(policy, FIXED_NOW + 2);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    // A recall is a re-call to the same counter, so it mirrors markCalling's
    // two-event shape: STATUS_UPDATED (SKIPPED -> CALLING) then TICKET_CALLED
    // carrying the retained counterId + ticket number (FR-TV-01/02).
    const events = ticket.pullDomainEvents();
    expect(events.map((e) => e.type)).toEqual(['STATUS_UPDATED', 'TICKET_CALLED']);
    expect(events[0]).toBeInstanceOf(TicketStatusChangedEvent);
    expect((events[0] as TicketStatusChangedEvent).actionLabel).toBe('Panggil Ulang');
    expect(events[1]).toBeInstanceOf(TicketCalledEvent);
    expect((events[1] as TicketCalledEvent).counterId).toBe(1);
    expect((events[1] as TicketCalledEvent).ticketNumber).toBe('A-001');
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

  describe('lifecycle timestamps (QUE-26 — wait-time / service-time metrics)', () => {
    it('starts with null called/served/completed timestamps', () => {
      const ticket = newTicket();
      expect(ticket.calledAt).toBeNull();
      expect(ticket.servedAt).toBeNull();
      expect(ticket.completedAt).toBeNull();
    });

    it('sets calledAt on markCalling, servedAt on startServing, completedAt on complete', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      expect(ticket.calledAt).toBe(FIXED_NOW);
      ticket.startServing(policy, FIXED_NOW + 10);
      expect(ticket.servedAt).toBe(FIXED_NOW + 10);
      ticket.complete(policy, FIXED_NOW + 30);
      expect(ticket.completedAt).toBe(FIXED_NOW + 30);
    });

    it('recall re-sets calledAt to the recall time (fresh call attempt)', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.skip(policy, FIXED_NOW + 5);
      ticket.recall(policy, FIXED_NOW + 20);
      expect(ticket.calledAt).toBe(FIXED_NOW + 20);
    });

    it('transfer clears all three timestamps (fresh lifecycle under new category)', () => {
      const transferPolicy = new StateMachine(
        StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
        [
          ['WAITING', 'CALLING', 'Panggil Berikutnya'],
          ['CALLING', 'SERVING', 'Mulai melayani'],
          ['CALLING', 'SKIPPED', 'Lewati / Absen'],
          ['SERVING', 'COMPLETED', 'Selesai Layan'],
          ['CALLING', 'WAITING', 'Pindah Kategori'],
        ].map(([from, to, actionLabel]) => StateTransitionRule.of(from, to, actionLabel)),
      );
      const ticket = newTicket('CAT-A');
      ticket.markCalling(3, transferPolicy, FIXED_NOW); // sets calledAt
      ticket.pullDomainEvents();

      ticket.transferTo(
        'CAT-B',
        TicketNumber.of('B', 7),
        TicketStatus.WAITING,
        transferPolicy,
        FIXED_NOW + 40,
      );

      // Transfer re-enters the queue as a fresh ticket — the prior lifecycle
      // timestamps are cleared (served/completed were never set; called is reset).
      expect(ticket.calledAt).toBeNull();
      expect(ticket.servedAt).toBeNull();
      expect(ticket.completedAt).toBeNull();
    });
  });

  describe('transferTo (pindah kategori — FR-CLR-03)', () => {
    /**
     * The default state machine has no transfer edge. A transfer is a
     * first-class configurable transition, so the legal-transfer test uses a
     * machine that adds `CALLING -> WAITING` ("Pindah Kategori") to the PRD §7
     * default edges — exactly what the wizard/admin would configure to enable
     * transfers.
     */
    const transferPolicy = new StateMachine(
      StateSchema.of([
        'WAITING',
        'CALLING',
        'SERVING',
        'SKIPPED',
        'COMPLETED',
      ]),
      [
        ['WAITING', 'CALLING', 'Panggil Berikutnya'],
        ['CALLING', 'SERVING', 'Mulai Melayani'],
        ['CALLING', 'SKIPPED', 'Lewati / Absen'],
        ['SKIPPED', 'CALLING', 'Panggil Ulang'],
        ['SERVING', 'COMPLETED', 'Selesai Layan'],
        ['CALLING', 'WAITING', 'Pindah Kategori'],
      ].map(([from, to, actionLabel]) =>
        StateTransitionRule.of(from, to, actionLabel),
      ),
    );

    it('reassigns category + ticket number, clears the counter, and returns to WAITING', () => {
      const ticket = newTicket('CAT-A');
      ticket.markCalling(3, transferPolicy, FIXED_NOW);
      ticket.pullDomainEvents(); // drop call events to isolate transfer

      ticket.transferTo(
        'CAT-B',
        TicketNumber.of('B', 7),
        TicketStatus.WAITING,
        transferPolicy,
        FIXED_NOW + 1,
      );

      expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
      expect(ticket.categoryId).toBe('CAT-B');
      expect(ticket.ticketNumber.formatted()).toBe('B-007');
      expect(ticket.counterId).toBeNull();
    });

    it('emits a STATUS_UPDATED and a TICKET_TRANSFERRED event carrying old/new category + number', () => {
      const ticket = newTicket('CAT-A');
      ticket.markCalling(1, transferPolicy, FIXED_NOW);
      ticket.pullDomainEvents();

      ticket.transferTo(
        'CAT-B',
        TicketNumber.of('B', 7),
        TicketStatus.WAITING,
        transferPolicy,
        FIXED_NOW + 1,
      );

      const events = ticket.pullDomainEvents();
      expect(events.map((e) => e.type)).toEqual([
        'STATUS_UPDATED',
        'TICKET_TRANSFERRED',
      ]);
      expect(events[0]).toBeInstanceOf(TicketStatusChangedEvent);
      expect((events[0] as TicketStatusChangedEvent).actionLabel).toBe(
        'Pindah Kategori',
      );
      expect(events[1]).toBeInstanceOf(TicketTransferredEvent);
      const transferred = events[1] as TicketTransferredEvent;
      expect(transferred.fromCategoryId).toBe('CAT-A');
      expect(transferred.toCategoryId).toBe('CAT-B');
      expect(transferred.fromTicketNumber).toBe('A-001');
      expect(transferred.toTicketNumber).toBe('B-007');
    });

    it('throws InvalidStateTransitionException when the active machine has no transfer edge', () => {
      // StateMachine.DEFAULT has no CALLING -> WAITING edge.
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.pullDomainEvents();

      expect(() =>
        ticket.transferTo(
          'CAT-B',
          TicketNumber.of('B', 1),
          TicketStatus.WAITING,
          policy,
          FIXED_NOW + 1,
        ),
      ).toThrow(InvalidStateTransitionException);

      // State must be unchanged and no event recorded after a rejected transfer.
      expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
      expect(ticket.categoryId).toBe('CAT-A');
      expect(ticket.ticketNumber.formatted()).toBe('A-001');
      expect(ticket.pendingEventCount).toBe(0);
    });
  });
});