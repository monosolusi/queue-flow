import { describe, expect, it } from 'vitest';
import { makeQueueReducer, type QueueAction, type QueueState } from './queue-store';
import type { QueueLifecycleWireEvent, QueueSnapshotDto, TicketStateDto } from '../api/types';

const COUNTER = 1;
const ctx = { counterId: COUNTER, categoryIds: new Set(['cat-a']) };
const reducer = makeQueueReducer(ctx);

const baseState: QueueState = {
  counterId: COUNTER,
  active: [],
  waiting: [],
  skipped: [],
  waitingCount: 0,
  connection: 'closed',
  loadStatus: 'loaded',
  loadError: null,
  stale: false,
  configVersion: 0,
};

const waitingTicket = (id: string, num: string, categoryId = 'cat-a'): TicketStateDto => ({
  ticketId: id,
  ticketNumber: num,
  categoryId,
  status: 'WAITING',
  counterId: null,
});

const skippedTicket = (id: string, num: string, categoryId = 'cat-a'): TicketStateDto => ({
  ticketId: id,
  ticketNumber: num,
  categoryId,
  status: 'SKIPPED',
  counterId: COUNTER,
});

function event(
  type: QueueLifecycleWireEvent['type'],
  aggregateId: string,
  payload: QueueLifecycleWireEvent['payload'],
): QueueAction {
  return { type: 'EVENT', event: { type, aggregateId, occurredAt: 1, version: 1, payload } };
}

describe('queueReducer — snapshot', () => {
  it('SNAPSHOT_LOADED seeds active/waiting/skipped/waitingCount', () => {
    const action: QueueAction = {
      type: 'SNAPSHOT_LOADED',
      snapshot: {
        counterId: COUNTER,
        active: [{ ticketId: 'a1', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'CALLING', counterId: COUNTER }],
        waiting: [waitingTicket('w1', 'A-002')],
        skipped: [skippedTicket('s1', 'A-004')],
        waitingCount: 1,
      },
    };
    const next = reducer(baseState, action);
    expect(next.active).toHaveLength(1);
    expect(next.waiting).toHaveLength(1);
    expect(next.skipped.map((t) => t.ticketNumber)).toEqual(['A-004']);
    expect(next.waitingCount).toBe(1);
    expect(next.loadStatus).toBe('loaded');
  });

  it('tolerates a snapshot that arrives without the skipped bucket', () => {
    // The DTO describes parsed JSON, not a typed literal: a service-worker-cached
    // client can outlive the response shape it was built against. A missing
    // bucket must read as "nothing skipped", not crash the projection.
    const withoutBucket: QueueSnapshotDto = {
      counterId: COUNTER,
      active: [],
      waiting: [waitingTicket('w1', 'A-002')],
      waitingCount: 1,
    };
    const next = reducer(baseState, { type: 'SNAPSHOT_LOADED', snapshot: withoutBucket });
    expect(next.skipped).toEqual([]);
    expect(next.waiting).toHaveLength(1);
  });

  it('keeps the snapshot’s skip order (oldest first) instead of re-sorting it', () => {
    // The server sends this bucket in `updatedAt` ascending — the order staff
    // work the absent customers back through. Ticket numbers say nothing about
    // it: B-003 was skipped before A-011 and must stay above it.
    const action: QueueAction = {
      type: 'SNAPSHOT_LOADED',
      snapshot: {
        counterId: COUNTER,
        active: [],
        waiting: [],
        skipped: [skippedTicket('s1', 'B-003', 'cat-b'), skippedTicket('s2', 'A-011')],
        waitingCount: 0,
      },
    };
    expect(reducer(baseState, action).skipped.map((t) => t.ticketNumber)).toEqual(['B-003', 'A-011']);
  });

  it('keeps the snapshot’s waiting order (waiting_order ASC) instead of re-sorting it', () => {
    // The server sends this bucket `waiting_order ASC, created_at ASC` — the
    // queue position, NOT the ticket number. A-005 can sit ahead of A-003:
    // A-003 was re-queued to the back (TO_BACK / BACK_N) and now has the
    // larger `waiting_order`. A client that re-sorted by ticket number would
    // flip them to `['A-003', 'A-005']` — the live-vs-reload divergence this
    // test pins. The fixture is in the OPPOSITE order to the ticket numbers
    // so a ticket-number sort is the failing case, not a coincidence.
    const action: QueueAction = {
      type: 'SNAPSHOT_LOADED',
      snapshot: {
        counterId: COUNTER,
        active: [],
        waiting: [waitingTicket('w5', 'A-005'), waitingTicket('w3', 'A-003')],
        waitingCount: 2,
      },
    };
    const next = reducer(baseState, action);
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-005', 'A-003']);
    expect(next.stale).toBe(false);
  });

  it('SNAPSHOT_ERROR sets error state', () => {
    const next = reducer(baseState, { type: 'SNAPSHOT_ERROR', message: 'boom' });
    expect(next.loadStatus).toBe('error');
    expect(next.loadError).toBe('boom');
  });
});

describe('queueReducer — TICKET_CREATED', () => {
  it('adds a waiting ticket when its category is in scope', () => {
    const next = reducer(
      baseState,
      event('TICKET_CREATED', 't-new', { ticketNumber: 'A-003', categoryId: 'cat-a' }),
    );
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-003']);
    expect(next.waitingCount).toBe(1);
  });

  it('ignores tickets in other categories', () => {
    const next = reducer(
      baseState,
      event('TICKET_CREATED', 't-new', { ticketNumber: 'B-001', categoryId: 'cat-b' }),
    );
    expect(next.waiting).toHaveLength(0);
  });

  it('is idempotent for a duplicate create', () => {
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't-new', { ticketNumber: 'A-003', categoryId: 'cat-a' }),
    );
    next = reducer(next, event('TICKET_CREATED', 't-new', { ticketNumber: 'A-003', categoryId: 'cat-a' }));
    expect(next.waiting).toHaveLength(1);
  });

  it('preserves the server waiting order on a new ticket (does NOT re-sort by ticket number)', () => {
    // Regression guard for the reported bug: the waiting list used to be
    // re-sorted by `localeCompare(ticketNumber)` on every WS event, which
    // discarded the server's `waiting_order` ordering. Seed the list in a
    // NON-ticket-number order the server could really send (A-005 ahead of
    // A-003 — A-003 was re-queued to the back), then create A-006. A new
    // ticket has `waiting_order = clock()` (the largest), so it belongs at
    // the BACK. The list must stay `['A-005', 'A-003', 'A-006']` — the
    // failing case (old behaviour) re-sorted to `['A-003', 'A-005', 'A-006']`.
    const seeded: QueueState = {
      ...baseState,
      waiting: [waitingTicket('w5', 'A-005'), waitingTicket('w3', 'A-003')],
      waitingCount: 2,
    };
    const next = reducer(
      seeded,
      event('TICKET_CREATED', 't-new', { ticketNumber: 'A-006', categoryId: 'cat-a' }),
    );
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-005', 'A-003', 'A-006']);
    // The frequent kiosk create path must NOT trigger a snapshot refetch.
    expect(next.stale).toBe(false);
  });
});

describe('queueReducer — TICKET_CALLED', () => {
  it('promotes to active and removes from waiting when called at my counter', () => {
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't1', { ticketNumber: 'A-001', categoryId: 'cat-a' }),
    );
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }));
    expect(next.active.map((t) => t.ticketNumber)).toEqual(['A-001']);
    // The TICKET_CALLED payload carries no categoryId; the promoted active
    // ticket reuses the categoryId from its prior waiting entry (FR-CLR-03
    // transfer-chooser correctness), not a blank.
    expect(next.active[0].categoryId).toBe('cat-a');
    expect(next.waiting).toHaveLength(0);
  });

  it('removes from waiting when called at another counter', () => {
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't1', { ticketNumber: 'A-001', categoryId: 'cat-a' }),
    );
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: 2 }));
    expect(next.waiting).toHaveLength(0);
    expect(next.active).toHaveLength(0);
  });
});

describe('queueReducer — STATUS_UPDATED', () => {
  it('updates active ticket status CALLING -> SERVING', () => {
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SERVING' }));
    expect(next.active[0].status).toBe('SERVING');
  });

  it('returns a re-queued ticket to the waiting list on WAITING (the manager\'s edge)', () => {
    // `CALLING → WAITING` declared "Ubah Status": a plain re-queue, with no
    // TICKET_TRANSFERRED behind it. Leaving the ticket in `active` with a WAITING
    // status would strand it on the counter panel — and because call-next locks
    // while a ticket is active, the staff could neither serve it nor call the next.
    let next = reducer(
      { ...baseState, waiting: [waitingTicket('t1', 'A-001')], waitingCount: 1 },
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    expect(next.active).toHaveLength(1);
    expect(next.waiting).toHaveLength(0);

    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'WAITING' }));

    expect(next.active).toHaveLength(0);
    expect(next.skipped).toHaveLength(0);
    // Same number, same category — a re-queue is not a category move.
    expect(next.waiting.map((t) => [t.ticketNumber, t.categoryId, t.status])).toEqual([
      ['A-001', 'cat-a', 'WAITING'],
    ]);
    expect(next.waiting[0].counterId).toBeNull();
    expect(next.waitingCount).toBe(1);
    // A re-queue back into MY categories re-stamps `waiting_order` (and may
    // renumber siblings); the correct position is not on the wire, so the
    // store marks itself stale for the provider to refetch the authoritative
    // order.
    expect(next.stale).toBe(true);
  });

  it('optimistically appends a re-queued ticket to the end and marks stale (KEEP/BACK_N)', () => {
    // The store cannot compute the re-queue position from the wire: KEEP
    // returns the ticket to its ORIGINAL `waiting_order` (which the client
    // no longer knows — it left `waiting` when called), BACK_N is an exact-
    // rank insertion, TO_BACK is the end. So it appends optimistically (the
    // ticket leaves the active panel instantly, unlocking call-next) and
    // marks stale so the refetch corrects the position AND picks up any
    // BACK_N-renumbered siblings (which get no per-sibling WS event).
    //
    // The optimistic append lands A-005 at the END — intentionally WRONG for
    // a KEEP re-queue (its preserved `waiting_order` should put it back at
    // the front, `['A-005', 'A-003']`). `stale` is the contract that the
    // refetch will correct it; this test pins that contract, not the wrong
    // interim order.
    let next: QueueState = {
      ...baseState,
      waiting: [waitingTicket('w5', 'A-005'), waitingTicket('w3', 'A-003')],
      waitingCount: 2,
    };
    next = reducer(next, event('TICKET_CALLED', 'w5', { ticketNumber: 'A-005', counterId: COUNTER }));
    expect(next.active).toHaveLength(1);
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-003']);

    next = reducer(next, event('STATUS_UPDATED', 'w5', { from: 'CALLING', to: 'WAITING' }));

    // The ticket left the active panel — call-next unlocks.
    expect(next.active).toHaveLength(0);
    expect(next.skipped).toHaveLength(0);
    // Optimistic append to the END (wrong for KEEP; corrected by refetch).
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-003', 'A-005']);
    // The refetch contract: the provider will reload the authoritative order.
    expect(next.stale).toBe(true);
  });

  it('drops a re-queued ticket whose category this counter does not serve', () => {
    // The waiting list is category-scoped, so a ticket re-queued under a category
    // this counter does not serve leaves every bucket rather than appearing in a
    // list it does not belong to.
    let next = reducer(
      { ...baseState, waiting: [waitingTicket('t1', 'B-001', 'cat-b')], waitingCount: 1 },
      event('TICKET_CALLED', 't1', { ticketNumber: 'B-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'WAITING' }));
    expect(next.active).toHaveLength(0);
    expect(next.waiting).toHaveLength(0);
    // A re-queue in another category does not renumber THIS counter's
    // siblings, and the ticket left this view entirely — no refetch needed.
    expect(next.stale).toBe(false);
  });

  it('re-queues a skipped ticket too, clearing it out of the skipped bucket', () => {
    // A `SKIPPED → WAITING` edge is a legitimate flow: give up on re-calling and
    // put the customer back in line. It must leave the skipped list, or the row
    // would keep offering "Panggil Ulang" for a ticket that is already queued.
    let next = reducer(
      { ...baseState, skipped: [skippedTicket('s1', 'A-004')] },
      event('STATUS_UPDATED', 's1', { from: 'SKIPPED', to: 'WAITING' }),
    );
    expect(next.skipped).toHaveLength(0);
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-004']);
    // Same re-queue branch as the from-active path: the ticket re-enters MY
    // category (cat-a), so the store marks stale for the provider to refetch
    // the authoritative `waiting_order` position. Pins the from-skipped
    // branch so a future gate like `from === 'CALLING'` cannot regress it.
    expect(next.stale).toBe(true);
  });

  it('removes the ticket on COMPLETED', () => {
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'SERVING', to: 'COMPLETED' }));
    expect(next.active).toHaveLength(0);
  });

  it('MOVES the ticket to the skipped list on SKIPPED (never drops it)', () => {
    // The defect this replaces: SKIPPED evicted the ticket from every list, so
    // no surface could offer the flow's SKIPPED → CALLING edge ("Panggil
    // Ulang") and an absent customer could never be re-called.
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't1', { ticketNumber: 'A-001', categoryId: 'cat-a' }),
    );
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }));
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
    expect(next.active).toHaveLength(0);
    expect(next.skipped.map((t) => [t.ticketId, t.status])).toEqual([['t1', 'SKIPPED']]);
    // The ticket keeps the fields the lean payload never carried.
    expect(next.skipped[0].ticketNumber).toBe('A-001');
    expect(next.skipped[0].categoryId).toBe('cat-a');
    // It is NOT back in line: waiting stays a picture of the queue.
    expect(next.waiting).toHaveLength(0);
  });

  it('keeps the skipped list in SKIP order, not ticket-number order', () => {
    // The list must not depend on how you arrived at it. The server returns
    // this bucket oldest-skip-first (`findSkippedByCounter` reads updatedAt
    // ascending), so a client that re-sorted by ticket number would render one
    // order live and a different one after a reload — rows swapping under a
    // reaching finger on a touch panel is a mis-tap onto the wrong customer's
    // "Panggil Ulang". The fixture skips in the OPPOSITE order to the ticket
    // numbers, so a ticket-number sort is the failing case, not a coincidence.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't-b', { ticketNumber: 'B-003', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't-b', { from: 'CALLING', to: 'SKIPPED' }));
    next = reducer(next, event('TICKET_CALLED', 't-a', { ticketNumber: 'A-011', counterId: COUNTER }));
    next = reducer(next, event('STATUS_UPDATED', 't-a', { from: 'CALLING', to: 'SKIPPED' }));

    expect(next.skipped.map((t) => t.ticketNumber)).toEqual(['B-003', 'A-011']);
  });

  it('moves a genuinely re-skipped ticket to the end, matching the server ordering', () => {
    // A ticket recalled and then skipped again is the MOST recently skipped, and
    // the server agrees: `findSkippedByCounter` orders by updatedAt ascending,
    // which a re-skip bumps.
    //
    // Note what actually produces the append here: the recall's TICKET_CALLED
    // removes the ticket from the bucket on its way out, so by the time the
    // second SKIPPED arrives the ticket is ABSENT and `dedupeAppend` takes its
    // append branch. This case therefore does NOT discriminate append-after-
    // filter from replace-in-place — the test below is the one that pins the
    // dedupe branch.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't-b', { ticketNumber: 'B-003', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't-b', { from: 'CALLING', to: 'SKIPPED' }));
    next = reducer(next, event('TICKET_CALLED', 't-a', { ticketNumber: 'A-011', counterId: COUNTER }));
    next = reducer(next, event('STATUS_UPDATED', 't-a', { from: 'CALLING', to: 'SKIPPED' }));
    // B-003 is recalled, then skipped a second time.
    next = reducer(next, event('TICKET_CALLED', 't-b', { ticketNumber: 'B-003', counterId: COUNTER }));
    next = reducer(next, event('STATUS_UPDATED', 't-b', { from: 'CALLING', to: 'SKIPPED' }));

    expect(next.skipped.map((t) => t.ticketNumber)).toEqual(['A-011', 'B-003']);
  });

  it('a redelivered SKIPPED does not reorder the bucket', () => {
    // The only way to reach `dedupeAppend`'s dedupe branch: the same SKIPPED
    // event arriving twice for a ticket still in the bucket. Nothing changed
    // server-side (`updatedAt` is unmoved), so the row must not move — appending
    // after a filter would jump it past tickets skipped later, which is the
    // reorder-under-a-reaching-finger hazard the skip-order fix exists to
    // remove. A second ticket is required for the assertion to be able to fail.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't-b', { ticketNumber: 'B-003', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't-b', { from: 'CALLING', to: 'SKIPPED' }));
    next = reducer(next, event('TICKET_CALLED', 't-a', { ticketNumber: 'A-011', counterId: COUNTER }));
    next = reducer(next, event('STATUS_UPDATED', 't-a', { from: 'CALLING', to: 'SKIPPED' }));
    expect(next.skipped.map((t) => t.ticketNumber)).toEqual(['B-003', 'A-011']);

    // The B-003 SKIPPED broadcast is redelivered — no intervening recall.
    next = reducer(next, event('STATUS_UPDATED', 't-b', { from: 'CALLING', to: 'SKIPPED' }));

    expect(next.skipped.map((t) => t.ticketNumber)).toEqual(['B-003', 'A-011']);
    expect(next.skipped).toHaveLength(2);
  });

  it('is idempotent for a repeated SKIPPED', () => {
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
    expect(next.skipped).toHaveLength(1);
  });

  it('completes a skipped ticket out of the skipped list', () => {
    // A manager-configured SKIPPED → COMPLETED edge: COMPLETED is the one target
    // that leaves every surface.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'SKIPPED', to: 'COMPLETED' }));
    expect(next.skipped).toHaveLength(0);
    expect(next.active).toHaveLength(0);
  });

  it('keeps the ticket on the board for a custom in-progress status (QUE-33)', () => {
    // A custom status like PREPARING is an in-progress sub-state — the ticket
    // stays the active ticket at the counter, just with the new status. Only
    // COMPLETED/SKIPPED leave.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SERVING' }));
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'SERVING', to: 'PREPARING' }));
    expect(next.active).toHaveLength(1);
    expect(next.active[0].ticketId).toBe('t1');
    expect(next.active[0].status).toBe('PREPARING');
  });

  it('ignores STATUS_UPDATED for an unknown ticket', () => {
    const next = reducer(baseState, event('STATUS_UPDATED', 'ghost', { from: 'CALLING', to: 'SERVING' }));
    expect(next).toBe(baseState);
  });
});

describe('queueReducer — recall out of the skipped list (Panggil Ulang)', () => {
  /** Skips A-001 at this counter, the way the wire delivers it. */
  function skipActiveTicket(): QueueState {
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't1', { ticketNumber: 'A-001', categoryId: 'cat-a' }),
    );
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }));
    return reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
  }

  it('returns the ticket to the counter across the recall event pair', () => {
    // The aggregate records the status change first and re-emits TICKET_CALLED
    // second (so the TV re-shows + re-announces it), so the store sees both in
    // that order and both must land the ticket in the same place.
    let next = skipActiveTicket();
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'SKIPPED', to: 'CALLING' }));
    expect(next.skipped).toHaveLength(0);
    expect(next.active.map((t) => [t.ticketId, t.status])).toEqual([['t1', 'CALLING']]);

    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }));
    expect(next.active).toHaveLength(1);
    expect(next.skipped).toHaveLength(0);
    // The re-called ticket keeps its category: TICKET_CALLED carries none, and
    // the projection recovers it from local state rather than blanking it —
    // otherwise the transfer chooser silently loses its exclusion (FR-CLR-03).
    expect(next.active[0].categoryId).toBe('cat-a');
    expect(next.active[0].counterId).toBe(COUNTER);
  });

  it('recovers the category when TICKET_CALLED arrives first', () => {
    // Order-independence: the same recall reaching the store the other way round
    // (or with the status change lost) must not blank the category either.
    let next = skipActiveTicket();
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }));
    expect(next.skipped).toHaveLength(0);
    expect(next.active[0].categoryId).toBe('cat-a');
  });

  it('drops a skipped ticket picked up by another counter', () => {
    let next = skipActiveTicket();
    next = reducer(next, event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: 2 }));
    expect(next.skipped).toHaveLength(0);
    expect(next.active).toHaveLength(0);
  });

  it('moves a skipped ticket out of the list when it is transferred away', () => {
    let next = skipActiveTicket();
    next = reducer(
      next,
      event('TICKET_TRANSFERRED', 't1', {
        fromCategoryId: 'cat-a',
        toCategoryId: 'cat-b',
        fromTicketNumber: 'A-001',
        toTicketNumber: 'B-009',
      }),
    );
    expect(next.skipped).toHaveLength(0);
    expect(next.waiting).toHaveLength(0);
  });
});

describe('queueReducer — TICKET_TRANSFERRED', () => {
  it('adds the ticket to waiting when transferred into my categories', () => {
    const next = reducer(
      baseState,
      event('TICKET_TRANSFERRED', 't1', {
        fromCategoryId: 'cat-b',
        toCategoryId: 'cat-a',
        fromTicketNumber: 'B-001',
        toTicketNumber: 'A-009',
      }),
    );
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-009']);
    // A transfer re-enters waiting under a new category; the aggregate
    // preserves `waiting_order` (could be mid-list), so the correct position
    // is not on the wire — mark stale for the provider to refetch.
    expect(next.stale).toBe(true);
  });

  it('removes the waiting ticket when transferred out of my categories', () => {
    let next = reducer(
      baseState,
      event('TICKET_CREATED', 't1', { ticketNumber: 'A-001', categoryId: 'cat-a' }),
    );
    next = reducer(
      next,
      event('TICKET_TRANSFERRED', 't1', {
        fromCategoryId: 'cat-a',
        toCategoryId: 'cat-b',
        fromTicketNumber: 'A-001',
        toTicketNumber: 'B-009',
      }),
    );
    expect(next.waiting).toHaveLength(0);
    // The ticket left this counter's view entirely — no refetch needed.
    expect(next.stale).toBe(false);
  });

  it('evicts the active ticket when transferred away (STATUS_UPDATED + TICKET_TRANSFERRED, FR-CLR-03)', () => {
    // The aggregate emits STATUS_UPDATED (CALLING -> WAITING) then
    // TICKET_TRANSFERRED for a transfer of the active ticket. The two must
    // converge on one bucket: STATUS_UPDATED re-queues the ticket under its OLD
    // identity, and TICKET_TRANSFERRED replaces that entry with the new identity
    // (or drops it, for a transfer away). Neither may leave it on the board as
    // the active call.
    // Seeded in `waiting` first, the way call-next really picks a ticket — the
    // TICKET_CALLED payload carries no categoryId, so this is what makes the
    // ticket's category known to the projection at all.
    let next = reducer(
      { ...baseState, waiting: [waitingTicket('t1', 'A-001')], waitingCount: 1 },
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'WAITING' }));
    // Mid-flight: it has left the counter for the queue, under its old identity.
    expect(next.active).toHaveLength(0);
    expect(next.waiting.map((t) => [t.ticketNumber, t.status])).toEqual([['A-001', 'WAITING']]);
    next = reducer(
      next,
      event('TICKET_TRANSFERRED', 't1', {
        fromCategoryId: 'cat-a',
        toCategoryId: 'cat-b',
        fromTicketNumber: 'A-001',
        toTicketNumber: 'B-009',
      }),
    );
    expect(next.active).toHaveLength(0);
    expect(next.waiting).toHaveLength(0);
  });

  it('evicts from active and re-adds to waiting when the active ticket is transferred into my categories (FR-CLR-03)', () => {
    // Not seeded in `waiting` first, so TICKET_CALLED leaves the ticket's
    // categoryId as `''` and the mid-flight STATUS_UPDATED takes the DROP branch,
    // not the re-queue one (the sibling test above covers that). What this pins is
    // the convergence: TICKET_TRANSFERRED puts it in `waiting` under the new
    // identity regardless of which branch preceded it.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'WAITING' }));
    next = reducer(
      next,
      event('TICKET_TRANSFERRED', 't1', {
        fromCategoryId: 'cat-b',
        toCategoryId: 'cat-a',
        fromTicketNumber: 'B-001',
        toTicketNumber: 'A-009',
      }),
    );
    // The ticket must appear in waiting (new number) and NOT in active — not both.
    expect(next.active).toHaveLength(0);
    expect(next.waiting.map((t) => t.ticketNumber)).toEqual(['A-009']);
    expect(next.waiting[0].categoryId).toBe('cat-a');
    expect(next.waitingCount).toBe(1);
  });
});

describe('queueReducer — SYSTEM_RESET', () => {
  it('marks the state stale so the provider refetches', () => {
    const next = reducer(baseState, event('SYSTEM_RESET', 'sys', { resetTo: 1, date: '2026-07-30' }));
    expect(next.stale).toBe(true);
  });
});

describe('queueReducer — SYSTEM_CONFIG_CHANGED (FR-CLR-02)', () => {
  it('bumps configVersion so the workspace signals ActionControls to refetch the state machine', () => {
    const next = reducer(baseState, event('SYSTEM_CONFIG_CHANGED', 'system', {}));
    expect(next.configVersion).toBe(1);
    // No other state mutated — the store does not own the state machine.
    expect(next.active).toBe(baseState.active);
    expect(next.waiting).toBe(baseState.waiting);
    expect(next.stale).toBe(baseState.stale);
  });

  it('is monotonic across repeated config-change events', () => {
    let next = reducer(baseState, event('SYSTEM_CONFIG_CHANGED', 'system', {}));
    next = reducer(next, event('SYSTEM_CONFIG_CHANGED', 'system', {}));
    next = reducer(next, event('SYSTEM_CONFIG_CHANGED', 'system', {}));
    expect(next.configVersion).toBe(3);
  });
});