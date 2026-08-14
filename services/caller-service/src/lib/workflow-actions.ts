import type {
  TransitionActionType,
  WorkflowActionDto,
  WorkflowActionsDto,
  WorkflowActionUnavailableReason,
} from '../api/types';
import type { BoundCounter } from '../state/counter-binding';

/**
 * The counter panel's workflow presentation (FR-CLR-02). The admin-designed
 * state machine ("Alur Status Tiket") is the **source of truth** for which
 * buttons a ticket offers: the available actions are exactly the outgoing
 * transitions of that ticket's current status, each labelled with the
 * transition's `actionLabel` and running the `action` the manager declared for
 * it. The panel invents no steps of its own, and it decides nothing about what an
 * edge means.
 *
 * That last point used to be split: the backend resolved each `(from, to)` pair to
 * one of eight commands, and a pair does not carry enough information to say what
 * the manager meant — the rule for WAITING read every `X -> WAITING` edge as a
 * category move, so an edge drawn to re-queue a ticket rendered as "Pindah
 * Kategori" and asked for a destination category. The flow now declares the
 * action per edge, and both sides just read it.
 *
 * What lives here is presentation: grouping the transitions into the call-next
 * primary / the per-ticket cluster, preserving the admin's order, deriving stable
 * DOM ids and pending keys, and turning the wire's
 * {@link WorkflowActionUnavailableReason} code into the Indonesian sentence staff
 * read. Pure + framework-free so the whole derivation is unit-testable in
 * isolation; `workflow-commands.ts` performs the side effect.
 */

/** One outgoing transition of a ticket's current status as the panel renders it.
 *  `unavailableReason !== null` means running it would change nothing — the
 *  button is still rendered (disabled + the reason) so a configured edge never
 *  silently disappears. */
export interface WorkflowAction {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  /** What running it does, declared in the flow. `null` when this build does not
   *  recognize the value the server sent — treated exactly like an unrunnable
   *  edge rather than a live button that fails on tap. */
  readonly action: TransitionActionType | null;
  /** Indonesian, jargon-free wording for the wire's reason code; `null` when the
   *  action is runnable. */
  readonly unavailableReason: string | null;
}

/** Label used for the call-next button before the actions have loaded (PRD §7 default). */
export const DEFAULT_CALL_NEXT_LABEL = 'Panggil Berikutnya';

/** `NO_STATUS_CHANGE` — running it would leave the ticket exactly where it is:
 *  core-api short-circuits a transition whose target equals the current status,
 *  so the request succeeds, changes nothing and broadcasts nothing. A button
 *  that visibly does nothing reads as a broken panel, so say so instead. */
const NO_STATUS_CHANGE_REASON =
  'Transisi ini tidak mengubah status tiket, jadi tidak ada yang bisa dijalankan ' +
  'dari panel loket.';

/** Defensive wording for an edge this client cannot place: one the server marked
 *  unrunnable with a reason code this build does not know, or one whose `action`
 *  names a behaviour newer than this build. Still honest, still no jargon. */
const UNKNOWN_REASON = 'Aksi ini belum bisa dijalankan dari panel loket.';

/** The staff-facing sentence for a wire reason code. The backend owns the fact,
 *  this client owns the wording. */
function unavailableCopy(reason: WorkflowActionUnavailableReason | null): string {
  switch (reason) {
    case 'NO_STATUS_CHANGE':
      return NO_STATUS_CHANGE_REASON;
    default:
      return UNKNOWN_REASON;
  }
}

/**
 * The actions this build knows how to run — the runtime twin of the
 * {@link TransitionActionType} union, which exists only at compile time and so
 * cannot vet a value that arrives over the wire. Written as an exhaustive record
 * so adding a member to the union without teaching this module about it fails
 * `tsc`, and `workflow-commands.ts` stays the single place that maps an action to
 * an endpoint.
 */
const KNOWN_ACTIONS: Readonly<Record<TransitionActionType, true>> = {
  UPDATE_STATUS: true,
  TRANSFER_CATEGORY: true,
};
const KNOWN_ACTION_NAMES: ReadonlySet<string> = new Set(Object.keys(KNOWN_ACTIONS));

/**
 * Whether the wire's action is one this build can run. The two DTO copies are
 * versioned independently on purpose (core-api ships first, the panels are
 * redeployed after), so an `action` naming newer behaviour is an expected state,
 * not a bug — and it must not render as a live button that only fails on tap.
 * Treated exactly like an unrunnable edge: visible, disabled, explained.
 */
function isKnownAction(action: string): action is TransitionActionType {
  return KNOWN_ACTION_NAMES.has(action);
}

function toAction(dto: WorkflowActionDto): WorkflowAction {
  const action = isKnownAction(dto.action) ? dto.action : null;
  // An action this build does not know carries no reason code (the server
  // considers it runnable), so it degrades through the unknown wording — the
  // same graceful path an unknown reason code already takes.
  const reason = action === null ? null : dto.unavailableReason;
  const runnable = action !== null && dto.unavailableReason === null;
  return {
    from: dto.from,
    to: dto.to,
    actionLabel: dto.actionLabel,
    action,
    unavailableReason: runnable ? null : unavailableCopy(reason),
  };
}

/**
 * Whether a transition is the counter-level "next ticket" one. `WAITING ->
 * CALLING` is rendered as the panel's primary button rather than per ticket,
 * because `call-next` **picks** a ticket by routing + priority rather than acting
 * on one the staff named — a different operation, on a different surface.
 *
 * This is a presentation split — the one place the panel still reads anything off
 * an edge's endpoints — and it decides only WHERE the button goes.
 *
 * It is gated on `UPDATE_STATUS` because the primary button fires the
 * counter-level endpoint unconditionally: an edge the manager declared a category
 * move cannot be honoured there (nobody has picked a ticket yet, let alone a
 * destination category), and firing call-next for it would run something they did
 * not configure. Such an edge falls through to the per-ticket surface instead,
 * where the declaration IS honoured — visible either way, never silently dropped.
 */
function isCallNextEdge(dto: Pick<WorkflowActionDto, 'from' | 'to' | 'action'>): boolean {
  return dto.from === 'WAITING' && dto.to === 'CALLING' && dto.action === 'UPDATE_STATUS';
}

/**
 * The per-ticket actions for a ticket sitting in `status`: every outgoing
 * transition of that status **except** the counter-level call-next one (see
 * {@link isCallNextEdge}), which {@link callNextActionFor} renders separately.
 * Server order is preserved so the button order is the admin's, not ours. An
 * unknown status or unloaded actions yield none.
 */
export function ticketActionsFor(
  workflow: WorkflowActionsDto | null,
  status: string | null | undefined,
): readonly WorkflowAction[] {
  if (!workflow || !status) return [];
  return (workflow.byStatus[status] ?? []).filter((a) => !isCallNextEdge(a)).map(toAction);
}

/**
 * The counter-level call-next action, or `null` when the flow has **no**
 * `WAITING -> CALLING` edge — deleting that edge in the designer removes the
 * button, which is what "the flow is the source of truth" means (call-next would
 * 409 anyway: the aggregate validates that exact edge).
 *
 * Unloaded/failed actions (`workflow === null`) are deliberately NOT the same as
 * an absent edge: the panel must stay usable when the surface cannot be read, so
 * the PRD-default action is returned as a fallback and the caller surfaces the
 * load error alongside it.
 */
export function callNextActionFor(workflow: WorkflowActionsDto | null): WorkflowAction | null {
  if (!workflow) {
    return {
      from: 'WAITING',
      to: 'CALLING',
      actionLabel: DEFAULT_CALL_NEXT_LABEL,
      action: 'UPDATE_STATUS',
      unavailableReason: null,
    };
  }
  const edge = (workflow.byStatus.WAITING ?? []).find(isCallNextEdge);
  return edge ? toAction(edge) : null;
}

/**
 * Whether the panel can actually run this action. Two independent things stop it,
 * and both must stop it the same way: the flow says running it would change
 * nothing, or it declares behaviour this build does not know. One predicate, so
 * the buttons, their ids and the lists' hints cannot disagree about which
 * transitions are live.
 */
export function isRunnable(
  action: WorkflowAction,
): action is WorkflowAction & { readonly action: TransitionActionType } {
  return action.action !== null && action.unavailableReason === null;
}

/** The wire action name as a DOM-id slug (`TRANSFER_CATEGORY` →
 *  `transfer-category`) — mechanical, so the ids stay stable as the contract
 *  grows. */
function actionSlug(action: TransitionActionType): string {
  return action.toLowerCase().replace(/_/g, '-');
}

/**
 * Stable DOM test id for an action button. Keyed on the declared action plus the
 * target, because one status can offer several edges running the same action (two
 * different custom steps, say) and the target is what tells them apart.
 *
 * An action that cannot run takes the `unroutable` id whichever reason stopped
 * it, so the id matches what the button IS — a disabled button carrying a
 * runnable-looking id would read as live to anything selecting on it.
 */
export function actionTestId(action: WorkflowAction): string {
  if (!isRunnable(action)) return `action-unroutable-${action.to}`;
  return `action-${actionSlug(action.action)}-${action.to}`;
}

/**
 * Key identifying one in-flight command, so only the tapped button shows the
 * pending state. Scoped by ticket because the waiting list renders the same
 * action on many rows.
 */
export function actionRunKey(ticketId: string, action: WorkflowAction): string {
  return `${ticketId}:${action.from}->${action.to}`;
}

/** A transfer destination: a category this counter serves, by id + display name. */
export interface TransferCandidate {
  readonly id: string;
  readonly name: string;
}

/**
 * Destination categories a transfer could target: the bound counter's assigned
 * categories minus the ticket's own (a no-op category move is rejected by
 * core-api). Falls back to id-only labels for a binding persisted before
 * `assignedCategories` existed.
 */
export function transferCandidates(
  bound: BoundCounter,
  categoryId: string,
): readonly TransferCandidate[] {
  if (bound.assignedCategories.length > 0) {
    return bound.assignedCategories
      .filter((c) => c.id !== categoryId)
      .map((c) => ({ id: c.id, name: c.name }));
  }
  return bound.assignedCategoryIds.filter((id) => id !== categoryId).map((id) => ({ id, name: id }));
}
