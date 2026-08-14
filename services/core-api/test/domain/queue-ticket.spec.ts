import {
  InvalidArgumentException,
  InvalidStateTransitionException,
} from '../../src/domain/shared/errors';
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
import { TransitionAction } from '../../src/domain/shared';
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

/** `[from, to, actionLabel, action?]` — `action` omitted means UPDATE_STATUS. */
type EdgeSpec = readonly [string, string, string, TransitionAction?];

const DEFAULT_EDGES: readonly EdgeSpec[] = [
  ['WAITING', 'CALLING', 'Panggil Berikutnya'],
  ['CALLING', 'SERVING', 'Mulai Melayani'],
  ['CALLING', 'SKIPPED', 'Lewati / Absen'],
  ['SKIPPED', 'CALLING', 'Panggil Ulang'],
  ['SERVING', 'COMPLETED', 'Selesai Layan'],
];

/** A flow built from the PRD §7 default edges plus `extra`. */
function machineWith(...extra: readonly EdgeSpec[]): StateMachine {
  return new StateMachine(
    StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
    [...DEFAULT_EDGES, ...extra].map((e) => StateTransitionRule.of(e[0], e[1], e[2], e[3])),
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
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 1);
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
    ticket.applyTransition('COMPLETED', policy, FIXED_NOW + 2);
    expect(ticket.currentStatus).toBe(TicketStatus.COMPLETED);
  });

  it('supports skip then re-call (Panggil Ulang) and re-emits TICKET_CALLED', () => {
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.pullDomainEvents(); // drop the call events to isolate the re-call
    ticket.applyTransition('SKIPPED', policy, FIXED_NOW + 1);
    ticket.pullDomainEvents(); // drop the skip STATUS_UPDATED
    expect(ticket.currentStatus).toBe(TicketStatus.SKIPPED);
    // No counterId argument: a skipped ticket keeps the counter that called it,
    // so the re-call announces at that same counter.
    ticket.applyTransition('CALLING', policy, FIXED_NOW + 2);
    expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
    // A re-call mirrors markCalling's two-event shape: STATUS_UPDATED
    // (SKIPPED -> CALLING) then TICKET_CALLED carrying the retained counterId +
    // ticket number (FR-TV-01/02).
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
    expect(() => ticket.applyTransition('SERVING', policy, FIXED_NOW)).toThrow(
      InvalidStateTransitionException,
    );
    // state must be unchanged and no event recorded after a rejected transition
    expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
    expect(ticket.pendingEventCount).toBe(0);
  });

  it('cannot skip directly from WAITING (no WAITING -> SKIPPED edge)', () => {
    const ticket = newTicket();
    expect(() => ticket.applyTransition('SKIPPED', policy, FIXED_NOW)).toThrow(
      InvalidStateTransitionException,
    );
  });

  it('rejects a re-call from a status the flow has no edge into CALLING from', () => {
    // WAITING -> CALLING exists in the default flow, so use SERVING: the default
    // has no SERVING -> CALLING edge, and a ticket cannot be pulled back through
    // one the manager never drew.
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 1);
    expect(() => ticket.applyTransition('CALLING', policy, FIXED_NOW + 2)).toThrow(
      InvalidStateTransitionException,
    );
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
  });

  describe('a transition into CALLING (announcing a chosen ticket)', () => {
    it('announces a specific waiting ticket at the counter that ran the command', () => {
      // The counter-level call-next picks by routing + priority; this is the
      // per-ticket route, which is what makes any configured `-> CALLING` edge
      // runnable rather than only the two the old command table recognised.
      const ticket = newTicket();
      ticket.pullDomainEvents();

      ticket.applyTransition('CALLING', policy, FIXED_NOW + 1, 4);

      expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
      expect(ticket.counterId).toBe(4);
      expect(ticket.calledAt).toBe(FIXED_NOW + 1);
      const events = ticket.pullDomainEvents();
      expect(events.map((e) => e.type)).toEqual(['STATUS_UPDATED', 'TICKET_CALLED']);
      expect((events[1] as TicketCalledEvent).counterId).toBe(4);
    });

    it('prefers the supplied counter over the one the ticket already holds', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.applyTransition('SKIPPED', policy, FIXED_NOW + 1);
      ticket.pullDomainEvents();

      ticket.applyTransition('CALLING', policy, FIXED_NOW + 2, 9);

      expect(ticket.counterId).toBe(9);
    });

    it('throws InvalidArgumentException when no counter is available to announce at', () => {
      // A never-called ticket has no counter of its own, so a command that omits
      // one has nowhere to announce it. A missing argument, not an illegal edge.
      const ticket = newTicket();
      ticket.pullDomainEvents();

      expect(() => ticket.applyTransition('CALLING', policy, FIXED_NOW + 1)).toThrow(
        InvalidArgumentException,
      );
      expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
      expect(ticket.pendingEventCount).toBe(0);
    });

    it('re-announces on a CALLING -> CALLING self-loop without changing status', () => {
      const selfLoop = machineWith(['CALLING', 'CALLING', 'Panggil Lagi']);
      const ticket = newTicket();
      ticket.markCalling(1, selfLoop, FIXED_NOW);
      ticket.pullDomainEvents();

      ticket.applyTransition('CALLING', selfLoop, FIXED_NOW + 5, 1);

      expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
      // Only the announcement — no STATUS_UPDATED, because nothing moved.
      const events = ticket.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(TicketCalledEvent);
      expect(ticket.calledAt).toBe(FIXED_NOW + 5);
    });

    it('rejects a CALLING -> CALLING run when the flow draws no such edge', () => {
      // Without the self-loop the button does not exist; reaching the command
      // directly must not announce anything the flow did not authorise.
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.pullDomainEvents();

      expect(() => ticket.applyTransition('CALLING', policy, FIXED_NOW + 5, 1)).toThrow(
        InvalidStateTransitionException,
      );
      expect(ticket.pendingEventCount).toBe(0);
    });
  });

  describe('a transition into WAITING (back into the queue)', () => {
    // The manager's own scenario: an edge drawn from CALLING to WAITING to put a
    // ticket back in the queue. It is a plain status change — the category move
    // is a separate, declared action.
    const requeue = machineWith(['CALLING', 'WAITING', 'Kembalikan ke Antrian']);

    it('gives up the counter and clears the lifecycle timestamps', () => {
      const ticket = newTicket();
      ticket.markCalling(3, requeue, FIXED_NOW);
      expect(ticket.calledAt).toBe(FIXED_NOW);
      ticket.pullDomainEvents();

      ticket.applyTransition('WAITING', requeue, FIXED_NOW + 1);

      expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
      expect(ticket.counterId).toBeNull();
      // The wait starts over: a retained calledAt would report a wait that has
      // already ended (QUE-26).
      expect(ticket.calledAt).toBeNull();
      expect(ticket.servedAt).toBeNull();
      expect(ticket.completedAt).toBeNull();
    });

    it('keeps the category and the ticket number (it is not a category move)', () => {
      const ticket = newTicket('CAT-A');
      ticket.markCalling(3, requeue, FIXED_NOW);

      ticket.applyTransition('WAITING', requeue, FIXED_NOW + 1);

      expect(ticket.categoryId).toBe('CAT-A');
      expect(ticket.ticketNumber.formatted()).toBe('A-001');
    });

    it('emits one STATUS_UPDATED carrying the label the manager gave the edge', () => {
      const ticket = newTicket();
      ticket.markCalling(3, requeue, FIXED_NOW);
      ticket.pullDomainEvents();

      ticket.applyTransition('WAITING', requeue, FIXED_NOW + 1);

      const events = ticket.pullDomainEvents();
      expect(events.map((e) => e.type)).toEqual(['STATUS_UPDATED']);
      expect((events[0] as TicketStatusChangedEvent).actionLabel).toBe(
        'Kembalikan ke Antrian',
      );
    });

    it('leaves an already-waiting ticket untouched (no event, no timestamp rewrite)', () => {
      // A `WAITING -> WAITING` run short-circuits, so the side effects must not
      // fire: clearing calledAt on a request that recorded nothing would rewrite
      // the ticket's history invisibly. (This edge is published as
      // NO_STATUS_CHANGE, so the panel disables it — the guard is what makes that
      // published fact true.)
      const selfLoop = machineWith(
        ['CALLING', 'WAITING', 'Kembalikan ke Antrian'],
        ['WAITING', 'WAITING', 'Kembalikan ke Antrian'],
      );
      const ticket = newTicket();
      ticket.markCalling(3, selfLoop, FIXED_NOW);
      ticket.applyTransition('WAITING', selfLoop, FIXED_NOW + 1); // a real re-queue
      ticket.pullDomainEvents();

      ticket.applyTransition('WAITING', selfLoop, FIXED_NOW + 2); // already WAITING

      expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
      expect(ticket.updatedAt).toBe(FIXED_NOW + 1);
      expect(ticket.pendingEventCount).toBe(0);
    });
  });

  describe('reannounce (Panggil Lagi — re-announce a CALLING ticket, no state change)', () => {
    it('re-emits TICKET_CALLED with the retained counterId + ticket number and does not change status', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.pullDomainEvents(); // drop the call events to isolate the re-announce

      ticket.reannounce(FIXED_NOW + 5);

      // No state change — still CALLING, same counter.
      expect(ticket.currentStatus).toBe(TicketStatus.CALLING);
      expect(ticket.counterId).toBe(1);
      const events = ticket.pullDomainEvents();
      // Only the TICKET_CALLED re-emit — no STATUS_UPDATED (no transition).
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(TicketCalledEvent);
      expect((events[0] as TicketCalledEvent).type).toBe('TICKET_CALLED');
      expect((events[0] as TicketCalledEvent).counterId).toBe(1);
      expect((events[0] as TicketCalledEvent).ticketNumber).toBe('A-001');
    });

    it('re-sets calledAt to the re-announce time (fresh call attempt)', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      expect(ticket.calledAt).toBe(FIXED_NOW);
      ticket.reannounce(FIXED_NOW + 30);
      expect(ticket.calledAt).toBe(FIXED_NOW + 30);
    });

    it('needs no CALLING -> CALLING edge — it is not a transition', () => {
      // The default flow has no such edge, which is exactly why this stays its
      // own operation: "Panggil Lagi" must work on a stock install.
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      expect(() => ticket.reannounce(FIXED_NOW + 5)).not.toThrow();
    });

    it('is only valid from CALLING — throws InvalidStateTransitionException from WAITING', () => {
      const ticket = newTicket();
      ticket.pullDomainEvents(); // drop the creation event first
      expect(() => ticket.reannounce(FIXED_NOW)).toThrow(InvalidStateTransitionException);
      expect(ticket.currentStatus).toBe(TicketStatus.WAITING);
      expect(ticket.pendingEventCount).toBe(0);
    });

    it('throws InvalidStateTransitionException from SERVING / SKIPPED / COMPLETED', () => {
      // SERVING
      const serving = newTicket();
      serving.markCalling(1, policy, FIXED_NOW);
      serving.applyTransition('SERVING', policy, FIXED_NOW + 1);
      expect(() => serving.reannounce(FIXED_NOW + 2)).toThrow(InvalidStateTransitionException);

      // SKIPPED
      const skipped = newTicket();
      skipped.markCalling(1, policy, FIXED_NOW);
      skipped.applyTransition('SKIPPED', policy, FIXED_NOW + 1);
      expect(() => skipped.reannounce(FIXED_NOW + 2)).toThrow(InvalidStateTransitionException);

      // COMPLETED
      const completed = newTicket();
      completed.markCalling(1, policy, FIXED_NOW);
      completed.applyTransition('SERVING', policy, FIXED_NOW + 1);
      completed.applyTransition('COMPLETED', policy, FIXED_NOW + 2);
      expect(() => completed.reannounce(FIXED_NOW + 3)).toThrow(InvalidStateTransitionException);
    });
  });

  it('markCalling is a no-op when already CALLING (no counter change, no event)', () => {
    // call-next picks a ticket rather than acting on a named one, so re-picking
    // the same ticket must not re-announce it — unlike a deliberate
    // `CALLING -> CALLING` run, which exists to re-announce.
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
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 1);
    ticket.pullDomainEvents(); // clear all pending events
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 2); // SERVING -> SERVING (no-op)
    expect(ticket.currentStatus).toBe(TicketStatus.SERVING);
    expect(ticket.pendingEventCount).toBe(0);
  });

  it('does not re-stamp servedAt on a short-circuited SERVING -> SERVING run', () => {
    // The side effect is gated on the status having actually changed: a request
    // that records no event must not silently move the service clock.
    const ticket = newTicket();
    ticket.markCalling(1, policy, FIXED_NOW);
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 1);
    ticket.applyTransition('SERVING', policy, FIXED_NOW + 500);
    expect(ticket.servedAt).toBe(FIXED_NOW + 1);
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

    it('sets calledAt entering CALLING, servedAt entering SERVING, completedAt entering COMPLETED', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      expect(ticket.calledAt).toBe(FIXED_NOW);
      ticket.applyTransition('SERVING', policy, FIXED_NOW + 10);
      expect(ticket.servedAt).toBe(FIXED_NOW + 10);
      ticket.applyTransition('COMPLETED', policy, FIXED_NOW + 30);
      expect(ticket.completedAt).toBe(FIXED_NOW + 30);
    });

    it('a re-call re-sets calledAt to the re-call time (fresh call attempt)', () => {
      const ticket = newTicket();
      ticket.markCalling(1, policy, FIXED_NOW);
      ticket.applyTransition('SKIPPED', policy, FIXED_NOW + 5);
      ticket.applyTransition('CALLING', policy, FIXED_NOW + 20);
      expect(ticket.calledAt).toBe(FIXED_NOW + 20);
    });

    it('transfer clears all three timestamps (fresh lifecycle under new category)', () => {
      const transferPolicy = machineWith([
        'CALLING',
        'WAITING',
        'Pindah Kategori',
        TransitionAction.TRANSFER_CATEGORY,
      ]);
      const ticket = newTicket('CAT-A');
      ticket.markCalling(3, transferPolicy, FIXED_NOW); // sets calledAt
      ticket.pullDomainEvents();

      ticket.transferTo(
        'CAT-B',
        TicketNumber.of('B', 7),
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
     * machine that adds `CALLING -> WAITING` declared `TRANSFER_CATEGORY` —
     * exactly what the designer writes when the manager picks "Pindah Kategori"
     * as that edge's action. The endpoints alone would not be enough: the same
     * pair with the default `UPDATE_STATUS` action is a plain re-queue.
     */
    const transferPolicy = machineWith([
      'CALLING',
      'WAITING',
      'Pindah Kategori',
      TransitionAction.TRANSFER_CATEGORY,
    ]);

    it('reassigns category + ticket number, clears the counter, and returns to WAITING', () => {
      const ticket = newTicket('CAT-A');
      ticket.markCalling(3, transferPolicy, FIXED_NOW);
      ticket.pullDomainEvents(); // drop call events to isolate transfer

      ticket.transferTo(
        'CAT-B',
        TicketNumber.of('B', 7),
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
