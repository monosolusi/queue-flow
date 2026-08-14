import { EntityNotFoundException } from '../../src/domain/shared/errors';
import {
  InvalidArgumentException,
  InvalidStateTransitionException,
} from '../../src/domain/shared/errors';
import { TransitionAction, RequeuePolicyKind, type RequeuePolicy } from '../../src/domain/shared';
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

  describe('re-queue position policy (-> WAITING)', () => {
    /**
     * A flow whose `SERVING -> WAITING` edge carries a configurable re-queue
     * position policy. Each test builds its own machine so the policy under test
     * is on the edge the SERVING ticket transitions along.
     */
    function requeueMachine(policy: RequeuePolicy): StateMachine {
      return new StateMachine(
        StateSchema.of(['WAITING', 'CALLING', 'SERVING', 'SKIPPED', 'COMPLETED']),
        [
          StateTransitionRule.of('WAITING', 'CALLING', 'Panggil Berikutnya'),
          StateTransitionRule.of('CALLING', 'SERVING', 'Mulai Melayani'),
          StateTransitionRule.of('CALLING', 'SKIPPED', 'Lewati / Absen'),
          StateTransitionRule.of('SKIPPED', 'CALLING', 'Panggil Ulang'),
          StateTransitionRule.of('COMPLETED', 'WAITING', 'Kembalikan ke Antrian'),
          StateTransitionRule.of(
            'SERVING',
            'WAITING',
            'Kembalikan ke Antrian',
            TransitionAction.UPDATE_STATUS,
            policy,
          ),
        ],
      );
    }

    /** A SERVING ticket in CAT-A, with a given `waitingOrder` from its first WAITING. */
    function servingTicket(counterId = 1, waitingOrder = FIXED_NOW): QueueTicket {
      const machine = requeueMachine({ kind: RequeuePolicyKind.KEEP, n: null });
      const ticket = QueueTicket.create(
        ticketIdGenerate(),
        TicketNumber.of('A', 1),
        'CAT-A',
        FIXED_NOW,
      );
      // Force a specific `waitingOrder` via reconstitute so the test controls the
      // pre-requeue FIFO slot exactly (the aggregate `create` sets it to `now`).
      const reconstituted = QueueTicket.reconstitute({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        categoryId: 'CAT-A',
        status: 'WAITING',
        counterId: null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        waitingOrder,
        calledAt: null,
        servedAt: null,
        completedAt: null,
      });
      reconstituted.markCalling(counterId, machine, FIXED_NOW + 1);
      reconstituted.applyTransition('SERVING', machine, FIXED_NOW + 2);
      return reconstituted;
    }

    /** A WAITING sibling in CAT-A at a specific `waitingOrder`. */
    function waitingSibling(label: string, seq: number, waitingOrder: number): QueueTicket {
      return QueueTicket.reconstitute({
        id: ticketIdGenerate(),
        ticketNumber: TicketNumber.of('A', seq),
        categoryId: 'CAT-A',
        status: 'WAITING',
        counterId: null,
        createdAt: waitingOrder,
        updatedAt: waitingOrder,
        waitingOrder,
        calledAt: null,
        servedAt: null,
        completedAt: null,
      });
    }

    async function requeueToWaiting(
      machine: StateMachine,
      ticket: QueueTicket,
    ): Promise<void> {
      const requeueUseCase = new ApplyTransitionUseCase(
        queue,
        fakePolicyResolver(machine),
        dispatcher,
        clock,
      );
      await requeueUseCase.execute({ ticketId: ticket.id, targetStatus: TicketStatus.WAITING });
    }

    it('KEEP — leaves the ticket in its current FIFO slot (backward-compat default)', async () => {
      // A pre-existing config has no `requeuePolicy` key on the edge, so the VO
      // defaults to KEEP — and the use case keeps the ticket's `waitingOrder`.
      const machine = requeueMachine({ kind: RequeuePolicyKind.KEEP, n: null });
      const before = [waitingSibling('a', 2, 1_000), waitingSibling('b', 3, 2_000)];
      for (const t of before) await queue.save(t);
      const ticket = servingTicket(1, 1_500);
      await queue.save(ticket);

      await requeueToWaiting(machine, ticket);

      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.currentStatus).toBe('WAITING');
      expect(reloaded?.waitingOrder).toBe(1_500); // unchanged
      // FIFO order after re-queue: a (1000), ticket (1500), b (2000).
      const waiting = await queue.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.formatted())).toEqual(['A-002', 'A-001', 'A-003']);
    });

    it('TO_BACK — re-stamps to clock() and lands at the tail of its category', async () => {
      const machine = requeueMachine({ kind: RequeuePolicyKind.TO_BACK, n: null });
      const before = [waitingSibling('a', 2, 1_000), waitingSibling('b', 3, 2_000)];
      for (const t of before) await queue.save(t);
      const ticket = servingTicket(1, 1_500);
      await queue.save(ticket);

      await requeueToWaiting(machine, ticket);

      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.waitingOrder).toBe(FIXED_NOW + 10); // the clock's first tick
      // FIFO order: a (1000), b (2000), ticket (FIXED_NOW+10 — largest).
      const waiting = await queue.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.formatted())).toEqual(['A-002', 'A-003', 'A-001']);
    });

    it('BACK_N(1) — lands at index 1 via a midpoint when there is room', async () => {
      const machine = requeueMachine({ kind: RequeuePolicyKind.BACK_N, n: 1 });
      // 3 siblings at 1000-apart spacing — index 1 sits between 1000 and 2000.
      const before = [
        waitingSibling('a', 2, 0),
        waitingSibling('b', 3, 1_000),
        waitingSibling('c', 4, 2_000),
      ];
      for (const t of before) await queue.save(t);
      const ticket = servingTicket(1, 999);
      await queue.save(ticket);

      await requeueToWaiting(machine, ticket);

      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.waitingOrder).toBe(500); // midpoint of 0 and 1000
      const waiting = await queue.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.formatted())).toEqual([
        'A-002',
        'A-001',
        'A-003',
        'A-004',
      ]);
    });

    it('BACK_N collision — renumbers the category (siblings written via assignWaitingOrders) atomically', async () => {
      const machine = requeueMachine({ kind: RequeuePolicyKind.BACK_N, n: 1 });
      // Two siblings at the same ms (100) — gap is 0, no midpoint ⇒ renumber.
      const before = [
        waitingSibling('a', 2, 100),
        waitingSibling('b', 3, 100),
        waitingSibling('c', 4, 5_000),
      ];
      for (const t of before) await queue.save(t);
      const ticket = servingTicket(1, 50);
      await queue.save(ticket);

      const assignSpy = jest.spyOn(queue, 'assignWaitingOrders');

      await requeueToWaiting(machine, ticket);

      // The renumber path wrote the 3 siblings' waiting_order in one bulk call.
      expect(assignSpy).toHaveBeenCalledTimes(1);
      const assignments = assignSpy.mock.calls[0][0];
      expect(assignments).toHaveLength(3);

      const reloaded = await queue.findById(ticket.id);
      // Post-insertion sequence: [a, ticket, b, c] anchored at 100, step 1000.
      expect(reloaded?.waitingOrder).toBe(100 + 1000);
      const waiting = await queue.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.formatted())).toEqual([
        'A-002',
        'A-001',
        'A-003',
        'A-004',
      ]);
      // Sibling a stayed at 100; b moved to 2100; c moved to 3100.
      expect(waiting[0].waitingOrder).toBe(100);
      expect(waiting[2].waitingOrder).toBe(100 + 2 * 1000);
      expect(waiting[3].waitingOrder).toBe(100 + 3 * 1000);

      assignSpy.mockRestore();
    });

    it('a non-WAITING target is unaffected by the re-queue policy (no waiting_order write)', async () => {
      // A re-queue policy on a non-WAITING edge is never consulted. The
      // `SERVING -> PREPARING` edge in CUSTOM_MACHINE has no requeuePolicy, but
      // even a policy on it would be inert — only `targetStatus === WAITING`
      // resolves and applies one.
      const machine = requeueMachine({ kind: RequeuePolicyKind.TO_BACK, n: null });
      // Use the custom machine's PREPARING edge (CUSTOM_MACHINE), not the requeue
      // machine — prove the requeue policy stays inert on a non-WAITING target.
      useCase = new ApplyTransitionUseCase(
        queue,
        fakePolicyResolver(CUSTOM_MACHINE),
        dispatcher,
        clock,
      );
      const ticket = servingTicket(1, 1_500);
      await queue.save(ticket);

      await useCase.execute({ ticketId: ticket.id, targetStatus: 'PREPARING' });

      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.currentStatus).toBe('PREPARING');
      // No re-queue: waitingOrder is untouched (still the SERVING ticket's value).
      expect(reloaded?.waitingOrder).toBe(1_500);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('a pre-existing config (no requeuePolicy key on the edge) reconstitutes as KEEP', async () => {
      // CUSTOM_MACHINE's `SERVING -> WAITING` edge was built with
      // `StateTransitionRule.of(from, to, label)` — no requeuePolicy arg — so the
      // VO defaults it to KEEP (the single backward-compat boundary). Re-queueing
      // via that flow leaves the ticket in its current FIFO slot.
      const ticket = servingTicket(1, 1_500);
      await queue.save(ticket);
      const before = [waitingSibling('a', 2, 1_000), waitingSibling('b', 3, 2_000)];
      for (const t of before) await queue.save(t);

      useCase = new ApplyTransitionUseCase(
        queue,
        fakePolicyResolver(CUSTOM_MACHINE),
        dispatcher,
        clock,
      );
      await useCase.execute({ ticketId: ticket.id, targetStatus: TicketStatus.WAITING });

      const reloaded = await queue.findById(ticket.id);
      expect(reloaded?.waitingOrder).toBe(1_500); // KEEP — unchanged
      const waiting = await queue.findWaitingByCategory('CAT-A');
      expect(waiting.map((t) => t.ticketNumber.formatted())).toEqual(['A-002', 'A-001', 'A-003']);
    });
  });
});