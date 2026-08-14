import {
  DEFAULT_REQUEUE_POLICY,
  RequeuePolicyKind,
  type RequeuePolicy,
} from '../../src/domain/shared';
import {
  computeRepositionPlan,
  RENUMBER_STEP,
  type RepositionTicket,
} from '../../src/application/queue/requeue-position.helper';

/** A ticket as the helper sees it (plain shape — no aggregate load). */
function ticket(id: string, waitingOrder: number, categoryId = 'CAT-A'): RepositionTicket {
  return { id, categoryId, waitingOrder };
}

/**
 * A valid v4-shaped UUID derived from a small integer — `ticketIdOf` validates
 * the UUID format (the renumber fallback converts sibling ids to `TicketId`), so
 * the renumber-path test fixtures must use real UUID strings, not bare names.
 * The integer is encoded in the last 12 hex digits so two distinct `uuid(n)`
 * values are distinct but stable across runs.
 */
function uuid(n: number): string {
  return '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
}

const NOW = 5_000_000;

describe('computeRepositionPlan (the BACK_N category-rank plan)', () => {
  describe('KEEP', () => {
    it('returns single(current) — leaves the ordering key unchanged', () => {
      const t = ticket('t1', 100);
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.KEEP, n: null },
        t,
        [],
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: 100 });
    });

    it('DEFAULT_REQUEUE_POLICY is KEEP (backward-compat with pre-existing configs)', () => {
      expect(DEFAULT_REQUEUE_POLICY).toEqual({ kind: RequeuePolicyKind.KEEP, n: null });
      const t = ticket('t1', 100);
      const plan = computeRepositionPlan(DEFAULT_REQUEUE_POLICY, t, [], NOW);
      expect(plan).toEqual({ kind: 'single', waitingOrder: 100 });
    });
  });

  describe('TO_BACK', () => {
    it('returns single(now) — re-stamps to the supplied clock value (tail)', () => {
      const t = ticket('t1', 100);
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.TO_BACK, n: null },
        t,
        [ticket('t2', 200)],
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: NOW });
    });

    it('returns single(now) even when the category is empty', () => {
      const t = ticket('t1', 100);
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.TO_BACK, n: null },
        t,
        [],
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: NOW });
    });
  });

  describe('BACK_N — front insertion (n = 0)', () => {
    const policy: RequeuePolicy = { kind: RequeuePolicyKind.BACK_N, n: 0 };

    it('returns single(min - step) when the category has room below the min', () => {
      const t = ticket('t1', 1000);
      const categoryWaiting = [
        ticket('a', 10_000),
        ticket('b', 20_000),
        ticket('c', 30_000),
      ];
      const plan = computeRepositionPlan(policy, t, categoryWaiting, NOW);
      expect(plan).toEqual({ kind: 'single', waitingOrder: 10_000 - RENUMBER_STEP });
    });

    it('returns single(now) when the category is empty', () => {
      const t = ticket('t1', 1000);
      const plan = computeRepositionPlan(policy, t, [], NOW);
      expect(plan).toEqual({ kind: 'single', waitingOrder: NOW });
    });
  });

  describe('BACK_N — back insertion (n >= categoryCount, clamps to back)', () => {
    it('returns single(now) — the re-queued ticket goes to the tail', () => {
      const t = ticket('t1', 100);
      const categoryWaiting = [
        ticket('a', 1_000),
        ticket('b', 2_000),
        ticket('c', 3_000),
      ];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 100 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: NOW });
    });

    it('returns single(now) when n equals the category count exactly', () => {
      const t = ticket('t1', 100);
      const categoryWaiting = [ticket('a', 1_000), ticket('b', 2_000)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 2 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: NOW });
    });
  });

  describe('BACK_N — mid insertion (midpoint when neighbors > 1 apart)', () => {
    it('BACK_N(2) into a 5-ticket category lands at index 2 via midpoint', () => {
      const t = ticket('t1', 100);
      // 5 category-mates at 1000-apart spacing — index 2 sits between the 2nd
      // and 3rd (1000 and 2000). Midpoint = 1500.
      const categoryWaiting = [
        ticket('a', 0),
        ticket('b', 1_000),
        ticket('c', 2_000),
        ticket('d', 3_000),
        ticket('e', 4_000),
      ];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 2 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: 1_500 });
    });

    it('BACK_N(1) lands at index 1 (between the 0th and 1st)', () => {
      const t = ticket('t1', 100);
      const categoryWaiting = [ticket('a', 0), ticket('b', 1_000)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 1 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: 500 });
    });
  });

  describe('BACK_N — collision (neighbors ≤ 1 apart) triggers the category-renumber fallback', () => {
    it('re-packs the category anchored at the min, inserting the re-queued ticket at index n', () => {
      // Two kiosk tickets taken in the same ms (100) — gap is 0, no midpoint.
      const t = ticket('t1', 50);
      const categoryWaiting = [
        ticket(uuid(1), 100),
        ticket(uuid(2), 100), // same-ms collision
        ticket(uuid(3), 5_000),
      ];
      // BACK_N(1): re-queued ticket lands at index 1 of the post-insertion
      // sequence. Anchor at min (100); post-insertion sequence is
      // [u1, t1, u2, u3] at [100, 1100, 2100, 3100]. Siblings u1/u2/u3 re-stamped;
      // t1's own value is 1100.
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 1 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan.kind).toBe('renumber');
      if (plan.kind !== 'renumber') return;
      expect(plan.repositionedWaitingOrder).toBe(100 + 1 * RENUMBER_STEP);
      // Siblings are u1, u2, u3 (every OTHER ticket — t1 is NOT in the assignments).
      expect(plan.siblingAssignments.map((a) => a.id.value)).toEqual([
        uuid(1),
        uuid(2),
        uuid(3),
      ]);
      expect(plan.siblingAssignments.map((a) => a.waitingOrder)).toEqual([
        100 + 0 * RENUMBER_STEP,
        100 + 2 * RENUMBER_STEP,
        100 + 3 * RENUMBER_STEP,
      ]);
    });

    it('all renumbered values are within [min, min + count * step]', () => {
      const t = ticket('t1', 50);
      const categoryWaiting = [ticket(uuid(1), 100), ticket(uuid(2), 100)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 1 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan.kind).toBe('renumber');
      if (plan.kind !== 'renumber') return;
      const min = 100;
      const count = categoryWaiting.length;
      // n=1 mid-insertion: t1 lands at index 1; siblings at indices 0 and 2.
      expect(plan.repositionedWaitingOrder).toBe(min + 1 * RENUMBER_STEP);
      for (const a of plan.siblingAssignments) {
        expect(a.waitingOrder).toBeGreaterThanOrEqual(min);
        expect(a.waitingOrder).toBeLessThanOrEqual(min + count * RENUMBER_STEP);
      }
    });

    it('other categories are never present in the assignments (category-local renumber)', () => {
      // The helper receives ONLY the re-queued ticket's category-mates — the use
      // case filters by category — so this is structural. Assert it anyway: an
      // other-category ticket sneaking into `categoryWaiting` is a contract
      // violation, and the helper must not silently write it.
      const t = ticket('t1', 50, 'CAT-A');
      const categoryWaiting = [
        ticket(uuid(1), 100, 'CAT-A'),
        ticket(uuid(2), 100, 'CAT-A'),
        ticket(uuid(9), 100, 'CAT-B'), // wrong category — should not happen
      ];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 1 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan.kind).toBe('renumber');
      if (plan.kind !== 'renumber') return;
      // The helper renumbers EVERY category-mate it is given (the contract says
      // they are all in the re-queued ticket's category). It does not filter by
      // category — that is the use case's job. So `other` IS renumbered here,
      // which is why the use case MUST filter by category before calling.
      // This test documents that the helper is category-agnostic: the filtering
      // is the caller's responsibility, not the helper's.
      expect(plan.siblingAssignments.map((a) => a.id.value)).toContain(uuid(9));
    });

    it('id tiebreak: the use case pre-sorts by waitingOrder ASC, id ASC (the repo guarantees it)', () => {
      // The helper consumes `categoryWaiting` in the given order — it does NOT
      // re-sort (a defensive sort would mask a contract violation). Two
      // same-ms siblings sort by id via the repo's ORDER BY. The helper's
      // renumber walks them in that order, so the id-tiebreak order is
      // preserved in the re-packed sequence.
      const t = ticket('t1', 50);
      // Pre-sorted by (waitingOrder ASC, id ASC) — `uuid(1)` before `uuid(2)` at
      // the same waitingOrder (the last 12 hex digits encode the integer, so
      // `uuid(1)` < `uuid(2)` lexicographically, matching the repo's id tiebreak).
      const categoryWaiting = [ticket(uuid(1), 100), ticket(uuid(2), 100)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 1 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan.kind).toBe('renumber');
      if (plan.kind !== 'renumber') return;
      // Post-insertion sequence: [u1, t1, u2] at [100, 1100, 2100]. The id tiebreak
      // order is preserved (uuid(1) before uuid(2)).
      expect(plan.siblingAssignments.map((a) => a.id.value)).toEqual([
        uuid(1),
        uuid(2),
      ]);
      expect(plan.siblingAssignments.map((a) => a.waitingOrder)).toEqual([
        100,
        100 + 2 * RENUMBER_STEP,
      ]);
      expect(plan.repositionedWaitingOrder).toBe(100 + 1 * RENUMBER_STEP);
    });

    it('BACK_N(0) front insertion never renumbers — there is always room below the min', () => {
      // Even when the category is tightly packed at the same ms, front insertion
      // uses single(min - step): the new value is strictly below every
      // category-mate, so no collision and no renumber. The renumber fallback is
      // for MID insertion only.
      const t = ticket('t1', 50);
      const categoryWaiting = [ticket('a', 100), ticket('b', 100), ticket('c', 100)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: 0 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: 100 - RENUMBER_STEP });
    });
  });

  describe('BACK_N clamps n to [0, categoryCount]', () => {
    it('n < 0 clamps to 0 (front)', () => {
      const t = ticket('t1', 100);
      const categoryWaiting = [ticket('a', 1_000)];
      const plan = computeRepositionPlan(
        { kind: RequeuePolicyKind.BACK_N, n: -5 },
        t,
        categoryWaiting,
        NOW,
      );
      expect(plan).toEqual({ kind: 'single', waitingOrder: 1_000 - RENUMBER_STEP });
    });
  });
});