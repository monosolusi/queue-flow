import type {
  TransitionActionType,
  WorkflowActionDto,
  WorkflowActionsDto,
  WorkflowActionUnavailableReason,
} from '../api/types';

/**
 * Fixtures for the `GET /api/queue/actions` payload.
 *
 * Every edge carries the `action` **the manager declared** for it in "Alur Status
 * Tiket", which core-api passes through verbatim. `UPDATE_STATUS` is the default
 * here for the same reason it is on the wire: it is what an edge means unless the
 * manager said otherwise, and spelling it out at every call site would bury the
 * one case that matters.
 *
 * The panel derives no meaning from an edge's endpoints, so neither do these
 * fixtures: a `CALLING → WAITING` edge is a plain re-queue unless a test asks for
 * `TRANSFER_CATEGORY`, which is exactly the distinction the old
 * `(from, to) → command` table could not make.
 */

/** One transition exactly as the server sends it. */
export function edge(
  from: string,
  to: string,
  actionLabel: string,
  action: TransitionActionType = 'UPDATE_STATUS',
  unavailableReason: WorkflowActionUnavailableReason | null = null,
): WorkflowActionDto {
  return { from, to, actionLabel, action, unavailableReason };
}

/** Groups edges by source status, the shape `GET /api/queue/actions` returns. */
export function workflowActions(...edges: readonly WorkflowActionDto[]): WorkflowActionsDto {
  const byStatus = new Map<string, WorkflowActionDto[]>();
  for (const e of edges) {
    const list = byStatus.get(e.from) ?? [];
    list.push(e);
    byStatus.set(e.from, list);
  }
  return { byStatus: Object.fromEntries(byStatus) };
}

/** The PRD §7 default flow. Every edge is a plain status change — the default
 *  machine has no category move, which is why enabling one is a designer act. */
export const PRD_DEFAULT_WORKFLOW: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya'),
  edge('CALLING', 'SERVING', 'Mulai Melayani'),
  edge('CALLING', 'SKIPPED', 'Lewati / Absen'),
  edge('SKIPPED', 'CALLING', 'Panggil Ulang'),
  edge('SERVING', 'COMPLETED', 'Selesai Layan'),
);
