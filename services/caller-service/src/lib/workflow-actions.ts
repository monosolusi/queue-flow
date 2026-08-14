import type {
  WorkflowActionDto,
  WorkflowActionsDto,
  WorkflowActionUnavailableReason,
  WorkflowCommand,
} from '../api/types';
import type { BoundCounter } from '../state/counter-binding';

/**
 * The counter panel's workflow presentation (FR-CLR-02). The admin-designed
 * state machine ("Alur Status Tiket") is the **source of truth** for which
 * buttons a ticket offers: the available actions are exactly the outgoing
 * transitions of that ticket's current status, each labelled with the
 * transition's `actionLabel`. The panel invents no steps of its own.
 *
 * **Which command realizes which edge is the backend's decision**, delivered per
 * transition by `GET /api/queue/actions` (`WorkflowActionDto.command`). That
 * knowledge — which endpoint accepts which `(from, to)` pair, and why some pairs
 * accept none — belongs to core-api, so this module deliberately holds no
 * routing table of its own; a client-side copy could only drift out of step with
 * the server that enforces it.
 *
 * What stays here is presentation: grouping the transitions into the call-next
 * primary / the per-ticket flow cluster, preserving the admin's order, deriving
 * stable DOM ids and pending keys, and turning the wire's
 * {@link WorkflowActionUnavailableReason} code into the Indonesian sentence
 * staff read.
 * Pure + framework-free so the whole derivation is unit-testable in isolation;
 * `workflow-commands.ts` performs the side effect.
 */

/** One outgoing transition of a ticket's current status as the panel renders it.
 *  `command === null` means the transition is configured in the flow but nothing
 *  can run it from the counter — the button is still rendered (disabled +
 *  {@link unavailableReason}) so a configured edge never silently disappears. */
export interface WorkflowAction {
  readonly from: string;
  readonly to: string;
  readonly actionLabel: string;
  readonly command: WorkflowCommand | null;
  /** Indonesian, jargon-free wording for the wire's reason code; `null` while
   *  {@link command} is non-null. */
  readonly unavailableReason: string | null;
}

/** Label used for the call-next button before the actions have loaded (PRD §7 default). */
export const DEFAULT_CALL_NEXT_LABEL = 'Panggil Berikutnya';

/** `NO_COMMAND` — no endpoint realizes this edge from the counter panel. The
 *  usual case is an edge into "sedang dipanggil" from somewhere other than the
 *  waiting list or a skipped ticket: core-api exposes only the counter-level
 *  call-next (picks the next waiting ticket by routing/priority) and recall
 *  (skipped tickets only). */
const NO_COMMAND_REASON =
  'Tidak bisa dijalankan dari panel loket. Pemanggilan hanya dari daftar tunggu, ' +
  'atau panggil ulang untuk tiket yang dilewati.';

/** `NO_STATUS_CHANGE` — running it would leave the ticket exactly where it is:
 *  core-api short-circuits a transition whose target equals the current status,
 *  so the request succeeds, changes nothing and broadcasts nothing. A button
 *  that visibly does nothing reads as a broken panel, so say so instead. */
const NO_STATUS_CHANGE_REASON =
  'Transisi ini tidak mengubah status tiket, jadi tidak ada yang bisa dijalankan ' +
  'dari panel loket.';

/** Defensive wording for an edge this client cannot place: an unroutable one the
 *  server sent without a code (a reason code this client does not know yet), or
 *  one carrying a command name newer than this build. Still honest, still no
 *  jargon. */
const UNKNOWN_REASON = 'Aksi ini belum bisa dijalankan dari panel loket.';

/** The staff-facing sentence for a wire reason code. The backend owns the fact,
 *  this client owns the wording. */
function unavailableCopy(reason: WorkflowActionUnavailableReason | null): string {
  switch (reason) {
    case 'NO_COMMAND':
      return NO_COMMAND_REASON;
    case 'NO_STATUS_CHANGE':
      return NO_STATUS_CHANGE_REASON;
    default:
      return UNKNOWN_REASON;
  }
}

/**
 * The commands this build knows how to execute — the runtime twin of the
 * {@link WorkflowCommand} union, which exists only at compile time and so cannot
 * vet a value that arrives over the wire. Written as an exhaustive record so
 * adding a member to the union without teaching this module about it fails
 * `tsc`, and `workflow-commands.ts` stays the single place that maps a command
 * to an endpoint.
 */
const KNOWN_COMMANDS: Readonly<Record<WorkflowCommand, true>> = {
  CALL_NEXT: true,
  RECALL: true,
  REANNOUNCE: true,
  SERVE: true,
  COMPLETE: true,
  SKIP: true,
  TRANSFER: true,
  APPLY_TRANSITION: true,
};
const KNOWN_COMMAND_NAMES: ReadonlySet<string> = new Set(Object.keys(KNOWN_COMMANDS));

/**
 * Whether the wire's command is one this build can run. The two DTO copies are
 * versioned independently on purpose (core-api ships first, the panels are
 * redeployed after), so a `command` naming a newer endpoint is an expected
 * state, not a bug — and it must not render as a live button that only fails on
 * tap. Treated exactly like an unroutable edge: visible, disabled, explained.
 */
function isKnownCommand(command: WorkflowCommand | null): command is WorkflowCommand {
  return command !== null && KNOWN_COMMAND_NAMES.has(command);
}

function toAction(dto: WorkflowActionDto): WorkflowAction {
  const command = isKnownCommand(dto.command) ? dto.command : null;
  // A command this build does not know carries no reason code (the server sent
  // one it considers runnable), so it degrades through the unknown wording —
  // the same graceful path an unknown reason code already takes.
  const reason = dto.command === null ? dto.unavailableReason : null;
  return {
    from: dto.from,
    to: dto.to,
    actionLabel: dto.actionLabel,
    command,
    unavailableReason: command === null ? unavailableCopy(reason) : null,
  };
}

/**
 * The per-ticket actions for a ticket sitting in `status`: every outgoing
 * transition of that status **except** the one the server resolved to
 * `CALL_NEXT`, which is counter-level (it picks the next ticket by
 * routing/priority, it is not addressable per ticket) and is rendered separately
 * from {@link callNextActionFor}. Server order is preserved so the button order
 * is the admin's, not ours. An unknown status or unloaded actions yield none.
 */
export function ticketActionsFor(
  workflow: WorkflowActionsDto | null,
  status: string | null | undefined,
): readonly WorkflowAction[] {
  if (!workflow || !status) return [];
  return (workflow.byStatus[status] ?? []).filter((a) => a.command !== 'CALL_NEXT').map(toAction);
}

/**
 * The counter-level call-next action, or `null` when the flow has **no**
 * `CALL_NEXT` edge out of WAITING — deleting that edge in the designer removes
 * the button, which is what "the flow is the source of truth" means (call-next
 * would 409 anyway: the aggregate validates that exact edge).
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
      command: 'CALL_NEXT',
      unavailableReason: null,
    };
  }
  const edge = (workflow.byStatus.WAITING ?? []).find((a) => a.command === 'CALL_NEXT');
  return edge ? toAction(edge) : null;
}

/** The wire command name as a DOM-id slug (`APPLY_TRANSITION` →
 *  `apply-transition`) — mechanical, so the ids stay stable as the contract
 *  grows. */
function commandSlug(command: WorkflowCommand): string {
  return command.toLowerCase().replace(/_/g, '-');
}

/**
 * Stable DOM test id for an action button. Keyed on the command (so the
 * fixed-command buttons keep their long-standing ids) with the target appended
 * for the generic path, where one status can offer several custom edges.
 */
export function actionTestId(action: WorkflowAction): string {
  if (action.command === null) return `action-unroutable-${action.to}`;
  if (action.command === 'APPLY_TRANSITION') return `action-apply-transition-${action.to}`;
  return `action-${commandSlug(action.command)}`;
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
