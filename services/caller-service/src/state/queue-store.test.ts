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

  it('moves a re-skipped ticket to the end, matching the server ordering', () => {
    // A ticket recalled and then skipped again is the MOST recently skipped, and
    // the server agrees: `findSkippedByCounter` orders by updatedAt ascending,
    // which a re-skip bumps. Replacing in place would put the client back out of
    // step with a reload — the very divergence the append fix removes — so the
    // dedupe must re-append rather than preserve the old position.
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
    // A custom status like PREPARING (reached via the generic apply-transition
    // endpoint) is an in-progress sub-state — the ticket stays the active ticket
    // at the counter, just with the new status. Only COMPLETED/SKIPPED leave.
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
  });

  it('evicts the active ticket when transferred away (STATUS_UPDATED + TICKET_TRANSFERRED, FR-CLR-03)', () => {
    // The aggregate emits STATUS_UPDATED (CALLING -> WAITING) then
    // TICKET_TRANSFERRED for a transfer of the active ticket. STATUS_UPDATED
    // keeps the ticket on the board (WAITING is not terminal); TICKET_TRANSFERRED
    // must evict it from `active` so the board does not show a stale transferred-
    // away ticket as the active call.
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'WAITING' }));
    // Mid-flight: STATUS_UPDATED leaves the active ticket in place (now WAITING).
    expect(next.active).toHaveLength(1);
    expect(next.active[0].status).toBe('WAITING');
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