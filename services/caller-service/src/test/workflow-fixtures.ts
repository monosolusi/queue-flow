import type {
  WorkflowActionDto,
  WorkflowActionsDto,
  WorkflowActionUnavailableReason,
  WorkflowCommand,
} from '../api/types';

/**
 * Fixtures for the `GET /api/queue/actions` payload.
 *
 * Every edge declares the `command` **the server** resolved for it. The panel no
 * longer derives that (core-api owns which endpoint realizes which transition),
 * so a fixture that computed it would be re-implementing — and then testing — a
 * table this client does not have.
 */

/** One transition exactly as the server sends it. */
export function edge(
  from: string,
  to: string,
  actionLabel: string,
  command: WorkflowCommand | null,
  unavailableReason: WorkflowActionUnavailableReason | null = null,
): WorkflowActionDto {
  return { from, to, actionLabel, command, unavailableReason };
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

/** The PRD §7 default flow, as core-api resolves it. */
export const PRD_DEFAULT_WORKFLOW: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya', 'CALL_NEXT'),
  edge('CALLING', 'SERVING', 'Mulai Melayani', 'SERVE'),
  edge('CALLING', 'SKIPPED', 'Lewati / Absen', 'SKIP'),
  edge('SKIPPED', 'CALLING', 'Panggil Ulang', 'RECALL'),
  edge('SERVING', 'COMPLETED', 'Selesai Layan', 'COMPLETE'),
);
