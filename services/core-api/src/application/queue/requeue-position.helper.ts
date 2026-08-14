import type { WaitingOrderAssignment } from '../../domain/queue';
import { ticketIdOf } from '../../domain/queue';
import {
  type RequeuePolicy,
  RequeuePolicyKind,
} from '../../domain/shared';

/**
 * A re-queue position plan: either a single `waiting_order` write for the
 * re-queued ticket (KEEP / TO_BACK / BACK_N with room), or a category-local
 * renumber that re-packs the ticket's category and writes siblings' ordering
 * keys too (BACK_N mid-insertion collision fallback).
 *
 * Pure and framework-free — no IO, no domain ports. The use case loads the
 * category waiting list from the repo and passes it in; this helper decides
 * what to write. Fully unit-testable in isolation.
 */
export type RepositionPlan =
  | { readonly kind: 'single'; readonly waitingOrder: number }
  | {
      readonly kind: 'renumber';
      /** The re-queued ticket's own new `waiting_order` (one of the writes). */
      readonly repositionedWaitingOrder: number;
      /**
       * Sibling assignments — every OTHER ticket in the re-queued ticket's
       * category that needs its `waiting_order` re-stamped to make room. NEVER
       * includes the re-queued ticket itself (the use case persists that via
       * `queue.save(ticket)` after `applyTransition`; the siblings are written
       * via `queue.assignWaitingOrders`).
       */
      readonly siblingAssignments: readonly WaitingOrderAssignment[];
    };

/**
 * A ticket as the helper sees it: its id, its current `waitingOrder`, and its
 * category — enough to compute the plan, no aggregate load needed. The use
 * case supplies the re-queued ticket's own `{ id, categoryId, waitingOrder }`;
 * `categoryWaiting` supplies the same shape for every OTHER currently-WAITING
 * ticket in the re-queued ticket's category.
 */
export interface RepositionTicket {
  readonly id: string;
  readonly categoryId: string;
  readonly waitingOrder: number;
}

/**
 * The fixed gap (in epoch-ms-equivalent units) the category-renumber fallback
 * uses when re-packing a category. `1000` (1 s) is well below the inter-ticket
 * interval in normal operation (kiosk tickets are seconds apart) and well above
 * the `Date.now()` resolution edge case (two tickets in the same ms), so a
 * single renumber leaves comfortable room for future midpoint insertions
 * without another renumber. Matches the plan's "step = 1000".
 */
export const RENUMBER_STEP = 1000;

/**
 * Computes a re-queue position plan from the edge's {@link RequeuePolicy} and
 * the ticket's category-mates.
 *
 * `categoryWaiting` MUST exclude the re-queued ticket itself (the use case
 * filters it out) and MUST be pre-sorted by `waitingOrder ASC, id ASC` — the
 * repo's waiting reads guarantee that order. The helper does NOT re-sort (a
 * defensive sort would mask a contract violation).
 *
 * Semantics:
 * - `KEEP` ⇒ `single(current)` — leave `waiting_order` unchanged (the default;
 *   backward-compat with every pre-existing config).
 * - `TO_BACK` ⇒ `single(now)` — re-stamp to the supplied clock value (now is
 *   largest → tail). One write, no other tickets touched.
 * - `BACK_N(n)` ⇒ exact-rank insertion within the ticket's **own** category.
 *   `targetIndex = clamp(n, 0, categoryCount)` — `BACK_N(0)` = front, large `n`
 *   = back.
 *   - **Front insertion** (`targetIndex === 0`): `single(min - step)`. There is
 *     always room below the current min, so no collision and no renumber. If
 *     the category is empty, `single(now)`.
 *   - **Back insertion** (`targetIndex === categoryCount`): `single(now)`.
 *     `now` is ≥ the current max in practice (the clock advances); the sort's
 *     `created_at`/`id` tiebreaks handle a same-ms tie. If the category is
 *     empty, `single(now)`.
 *   - **Mid insertion** (`0 < targetIndex < categoryCount`): if the gap between
 *     the `(targetIndex - 1)`-th and `targetIndex`-th category-mates is > 1,
 *     `single(midpoint)` — ONE write. Otherwise (gap ≤ 1, e.g. two kiosk tickets
 *     in the same ms) re-pack ONLY the ticket's category with a fixed gap
 *     (`step`) anchored at the category's current `min`, inserting the
 *     re-queued ticket at `targetIndex` — the `renumber` plan. Other
 *     categories are NEVER written; their relative global order is exactly
 *     preserved.
 *
 * Returns the plan; the use case applies it (single ⇒ `applyTransition` +
 * `save`; renumber ⇒ `applyTransition` + `save` + `assignWaitingOrders`).
 */
export function computeRepositionPlan(
  policy: RequeuePolicy,
  ticket: RepositionTicket,
  categoryWaiting: readonly RepositionTicket[],
  now: number,
  step: number = RENUMBER_STEP,
): RepositionPlan {
  if (policy.kind === RequeuePolicyKind.KEEP) {
    return { kind: 'single', waitingOrder: ticket.waitingOrder };
  }
  if (policy.kind === RequeuePolicyKind.TO_BACK) {
    return { kind: 'single', waitingOrder: now };
  }
  // BACK_N(n): exact-rank insertion within the ticket's own category.
  const n = policy.n ?? 0;
  // `categoryWaiting` excludes the re-queued ticket. After insertion the ticket
  // occupies index `targetIndex` in a list of length `categoryCount + 1`.
  const categoryCount = categoryWaiting.length;
  const targetIndex = Math.max(0, Math.min(n, categoryCount));

  // Front insertion: below the current min. Always room (the new value is
  // strictly less than every category-mate), so no collision / no renumber.
  if (targetIndex === 0) {
    if (categoryCount === 0) {
      return { kind: 'single', waitingOrder: now };
    }
    const minWaitingOrder = categoryWaiting[0].waitingOrder;
    return { kind: 'single', waitingOrder: minWaitingOrder - step };
  }

  // Back insertion: at/after the current max. `now` is ≥ max in practice (the
  // clock advances); the sort's `created_at`/`id` tiebreaks handle a same-ms
  // tie, so a single write suffices — no renumber.
  if (targetIndex === categoryCount) {
    return { kind: 'single', waitingOrder: now };
  }

  // Mid insertion: midpoint between the `(targetIndex - 1)`-th and
  // `targetIndex`-th category-mates. Collision (gap ≤ 1) ⇒ category renumber.
  const lower = categoryWaiting[targetIndex - 1].waitingOrder;
  const upper = categoryWaiting[targetIndex].waitingOrder;
  if (upper - lower > 1) {
    // Integer midpoint (floor), strictly between lower and upper.
    return { kind: 'single', waitingOrder: lower + Math.floor((upper - lower) / 2) };
  }
  return renumberPlan(categoryWaiting, targetIndex, step);
}

/**
 * Builds the category-renumber fallback plan: re-packs the re-queued ticket's
 * category with a fixed gap (`step`) anchored at the category's current `min`,
 * inserting the re-queued ticket at `targetIndex`. Returns the re-queued
 * ticket's own new `waiting_order` plus the sibling assignments (every OTHER
 * ticket in the category, re-stamped).
 *
 * The new sequence is `[min, min + step, min + 2*step, …]` with the re-queued
 * ticket inserted at `targetIndex`. Every category-mate whose post-insertion
 * index is > `targetIndex` shifts one slot later. The re-queued ticket's own
 * slot is `min + targetIndex * step`. All values are within
 * `[min, min + categoryCount * step]`.
 *
 * Other categories are NEVER written — their `waiting_order` is untouched, so
 * their relative global order is exactly preserved. The category's own relative
 * order is preserved too (the re-pack is monotonic in the pre-pack order).
 */
function renumberPlan(
  categoryWaiting: readonly RepositionTicket[],
  targetIndex: number,
  step: number,
): Extract<RepositionPlan, { kind: 'renumber' }> {
  // Precondition: this is the BACK_N mid-insertion collision fallback, so
  // `0 < targetIndex < categoryWaiting.length` is guaranteed by the early
  // returns in `computeRepositionPlan` (front insertion → `single(min - step)`,
  // back insertion → `single(now)`). That is why the `i === targetIndex` branch
  // below is guaranteed to fire and overwrite `repositionedWaitingOrder` —
  // without it the initializer would leave the re-queued ticket at the front.
  if (targetIndex <= 0 || targetIndex >= categoryWaiting.length) {
    throw new Error(
      'renumberPlan is the mid-insertion fallback; targetIndex must be in (0, categoryCount)',
    );
  }
  const minWaitingOrder = categoryWaiting[0].waitingOrder;

  const siblingAssignments: WaitingOrderAssignment[] = [];
  let repositionedWaitingOrder = minWaitingOrder; // overwritten below
  // Walk the pre-sorted category-mates and interleave the re-queued ticket at
  // `targetIndex`. The post-insertion sequence is indexed by `writeIndex`; the
  // re-queued ticket occupies `writeIndex === targetIndex` and is NOT a sibling
  // (the use case persists it via `queue.save(ticket)` after `applyTransition`).
  let writeIndex = 0;
  for (let i = 0; i < categoryWaiting.length; i++) {
    if (i === targetIndex) {
      repositionedWaitingOrder = minWaitingOrder + writeIndex * step;
      writeIndex += 1;
    }
    const sibling = categoryWaiting[i];
    siblingAssignments.push({
      id: ticketIdOf(sibling.id),
      waitingOrder: minWaitingOrder + writeIndex * step,
    });
    writeIndex += 1;
  }
  return {
    kind: 'renumber',
    repositionedWaitingOrder,
    siblingAssignments,
  };
}