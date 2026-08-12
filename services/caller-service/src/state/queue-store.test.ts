import { describe, expect, it } from 'vitest';
import { makeQueueReducer, type QueueAction, type QueueState } from './queue-store';
import type { QueueLifecycleWireEvent, TicketStateDto } from '../api/types';

const COUNTER = 1;
const ctx = { counterId: COUNTER, categoryIds: new Set(['cat-a']) };
const reducer = makeQueueReducer(ctx);

const baseState: QueueState = {
  counterId: COUNTER,
  active: [],
  waiting: [],
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

function event(
  type: QueueLifecycleWireEvent['type'],
  aggregateId: string,
  payload: QueueLifecycleWireEvent['payload'],
): QueueAction {
  return { type: 'EVENT', event: { type, aggregateId, occurredAt: 1, version: 1, payload } };
}

describe('queueReducer — snapshot', () => {
  it('SNAPSHOT_LOADED seeds active/waiting/waitingCount', () => {
    const action: QueueAction = {
      type: 'SNAPSHOT_LOADED',
      snapshot: {
        counterId: COUNTER,
        active: [{ ticketId: 'a1', ticketNumber: 'A-001', categoryId: 'cat-a', status: 'CALLING', counterId: COUNTER }],
        waiting: [waitingTicket('w1', 'A-002')],
        waitingCount: 1,
      },
    };
    const next = reducer(baseState, action);
    expect(next.active).toHaveLength(1);
    expect(next.waiting).toHaveLength(1);
    expect(next.waitingCount).toBe(1);
    expect(next.loadStatus).toBe('loaded');
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

  it('removes the ticket on SKIPPED', () => {
    let next = reducer(
      baseState,
      event('TICKET_CALLED', 't1', { ticketNumber: 'A-001', counterId: COUNTER }),
    );
    next = reducer(next, event('STATUS_UPDATED', 't1', { from: 'CALLING', to: 'SKIPPED' }));
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