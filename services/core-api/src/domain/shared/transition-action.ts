/**
 * What a configured state-machine edge *does* when the counter staff runs it —
 * the manager's own declaration, made in the "Alur Status Tiket" designer
 * alongside the edge's target state and button label.
 *
 * This exists because the backend must **never infer an edge's meaning from the
 * name of its target state**. It used to: every `X -> WAITING` edge was executed
 * as a category move, so a manager who drew `CALLING -> WAITING` to put a ticket
 * back in the queue got a "Pindah Kategori" button demanding a destination
 * category — a step they never configured. The flow is the source of truth for
 * *which* state comes next; this value is the source of truth for *what runs*.
 * Both are read from the configuration; neither is guessed.
 *
 * - `UPDATE_STATUS`: move the ticket to the edge's target state. The canonical
 *   side effects of that state still apply (a ticket entering CALLING is
 *   announced; one returning to WAITING leaves its counter), because those are
 *   properties of the state itself, not of the manager's choice here.
 * - `TRANSFER_CATEGORY`: move the ticket to a **different category** — "pindah
 *   kategori" (FR-CLR-03) — re-issuing its per-category number, on top of the
 *   status change. The one action that needs a runtime argument (the destination
 *   category, chosen by staff), which is why it cannot be inferred and has to be
 *   declared.
 *
 * Lives in the shared kernel because both the Store Config context (the
 * {@link StateTransitionRule} the manager edits) and the Queue context (the
 * transition graph the queue commands enumerate) need it — keeping it here
 * avoids either bounded context importing the other (anti-corruption), exactly
 * as {@link PriorityPolicy} does.
 */
export enum TransitionAction {
  UPDATE_STATUS = 'UPDATE_STATUS',
  TRANSFER_CATEGORY = 'TRANSFER_CATEGORY',
}

export type TransitionActionValue = `${TransitionAction}`;

/**
 * The action names, as a set for membership testing. A TS string enum compiles to
 * a plain object, so `'x' in TransitionAction` is true for every
 * `Object.prototype` key — `action: "toString"` would pass validation and persist.
 * Mirrors the `CANONICAL_STATUSES` precedent in `queue/value-objects/ticket-status`.
 */
const TRANSITION_ACTIONS: ReadonlySet<string> = new Set<string>(Object.values(TransitionAction));

/** Whether an arbitrary wire value names a known action. */
export function isTransitionAction(value: unknown): value is TransitionActionValue {
  return typeof value === 'string' && TRANSITION_ACTIONS.has(value);
}
