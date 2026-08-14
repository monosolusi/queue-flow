import { InvalidValueObjectException } from './errors';

/**
 * What a configured `-> WAITING` edge does to the WAITING queue's order — the
 * manager's own declaration, made in the "Alur Status Tiket" designer alongside
 * the edge's target state and button label.
 *
 * Today the WAITING queue is ordered by the **immutable** `created_at` (FIFO),
 * and `QueueTicket.returnToQueue` (the `-> WAITING` side effect) keeps
 * `created_at`, so a `CALLING -> WAITING` "Kembalikan ke Antrian" edge snaps a
 * re-queued ticket back to its *original near-front* slot — not the back, and
 * never "n positions back." `created_at` cannot be re-stamped to fix this: it is
 * the wait-time metric origin (`calledAt - createdAt`); resetting it corrupts
 * FR-ADM-03 reporting. A separate ordering key (`waiting_order`) is re-stamped
 * instead, and the manager declares **how** per edge:
 *
 * - `KEEP`: leave `waiting_order` unchanged — the ticket keeps its current slot
 *   (the default, and what every pre-existing config means — backward-compat).
 * - `TO_BACK`: re-stamp `waiting_order = clock()` (now is largest → tail).
 * - `BACK_N(n)`: exact-rank insertion within the ticket's **own category** —
 *   midpoint between the `(n-1)`-th and `n`-th category-mates when there is room,
 *   or a category-local renumber fallback when neighbors collide (kiosk tickets
 *   taken in the same millisecond). `n` clamps to `[0, categoryCount]`.
 *
 * Lives in the shared kernel because both the Store Config context (the
 * {@link StateTransitionRule} the manager edits) and the Queue context (the
 * transition graph the queue commands enumerate, and the `returnToQueue`
 * applier) need it — keeping it here avoids either bounded context importing
 * the other (anti-corruption), exactly as {@link PriorityPolicy} does.
 *
 * Any `-> WAITING` edge may declare a non-KEEP policy; a non-KEEP policy on a
 * non-WAITING target is refused at save time by `SaveSystemConfigurationUseCase`,
 * not by this VO (DIP — the rule needs `TicketStatus` from the Queue context).
 */
export enum RequeuePolicyKind {
  KEEP = 'KEEP',
  TO_BACK = 'TO_BACK',
  BACK_N = 'BACK_N',
}

export type RequeuePolicyKindValue = `${RequeuePolicyKind}`;

/**
 * The policy as a set for membership testing. A TS string enum compiles to a
 * plain object, so `'x' in RequeuePolicyKind` is true for every
 * `Object.prototype` key — `kind: "toString"` would pass a naive `in` check and
 * persist. Mirrors the `CANONICAL_STATUSES` precedent.
 */
const REQUEUE_POLICY_KINDS: ReadonlySet<string> = new Set<string>(
  Object.values(RequeuePolicyKind),
);

/** Whether an arbitrary wire value names a known policy kind. */
export function isRequeuePolicyKind(value: unknown): value is RequeuePolicyKindValue {
  return typeof value === 'string' && REQUEUE_POLICY_KINDS.has(value);
}

/**
 * A re-queue position policy. `n` is the position argument for `BACK_N`
 * (non-negative integer); `null` for `KEEP` / `TO_BACK` (which take no
 * argument). A value object by composition: two policies are equal iff both
 * `kind` and `n` match.
 */
export interface RequeuePolicy {
  readonly kind: RequeuePolicyKindValue;
  readonly n: number | null;
}

/**
 * The default policy — `KEEP`. Carried by every edge that predates the field
 * (the wire carries no `requeuePolicy` key) and by every edge the manager has
 * not explicitly configured otherwise. `n: null` because KEEP takes no
 * argument. Declared BEFORE the `requeuePolicyFromWire` helper to avoid a TDZ
 * on any future `static` field that references it (mirrors the `CANONICAL_STATUSES`
 * module-level `const` placement).
 */
export const DEFAULT_REQUEUE_POLICY: RequeuePolicy = {
  kind: RequeuePolicyKind.KEEP,
  n: null,
};

/**
 * Reconstructs a {@link RequeuePolicy} from an unvalidated wire value (the
 * JSONB document / the wizard payload). The single backward-compat boundary:
 * an absent / `undefined` / `null` value reconstitutes as {@link DEFAULT_REQUEUE_POLICY}
 * (KEEP), so every configuration saved before this field existed keeps its
 * prior behavior — a re-queue leaves the ticket in its current FIFO slot.
 *
 * A present value MUST be a well-formed policy object:
 * - `kind` must name a known {@link RequeuePolicyKind} (the enum membership
 *   check uses a `Set`, not `in`, so `Object.prototype` keys are rejected —
 *   mirrors `CANONICAL_STATUSES`).
 * - `BACK_N` requires a present, non-negative integer `n` (a fractional,
 *   negative, or missing `n` is a malformed value object → 400 via
 *   `DomainExceptionFilter`).
 * - `KEEP` / `TO_BACK` ignore `n`; `null` is normalized for them so equality
 *   is stable.
 *
 * Throws {@link InvalidValueObjectException} (never a bare `Error`) so the
 * filter maps it to 400 — the VO owns its construction-failure semantics (SRP),
 * the same rule every other shared VO follows.
 */
export function requeuePolicyFromWire(value: unknown): RequeuePolicy {
  if (value === undefined || value === null) {
    return DEFAULT_REQUEUE_POLICY;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidValueObjectException(
      'requeuePolicy must be an object when present',
    );
  }
  const raw = value as { kind?: unknown; n?: unknown };
  if (!isRequeuePolicyKind(raw.kind)) {
    throw new InvalidValueObjectException(
      `requeuePolicy.kind must be one of ${Object.values(RequeuePolicyKind).join(', ')}`,
    );
  }
  if (raw.kind === RequeuePolicyKind.BACK_N) {
    if (
      typeof raw.n !== 'number' ||
      !Number.isInteger(raw.n) ||
      raw.n < 0
    ) {
      throw new InvalidValueObjectException(
        'requeuePolicy.n must be a non-negative integer when kind is BACK_N',
      );
    }
    return { kind: RequeuePolicyKind.BACK_N, n: raw.n };
  }
  // KEEP / TO_BACK take no argument. Normalize `n` to null so equality is
  // stable regardless of what (if anything) the wire carried.
  return { kind: raw.kind, n: null };
}