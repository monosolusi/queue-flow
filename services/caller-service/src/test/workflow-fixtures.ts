import type {
  WorkflowActionDto,
  WorkflowActionsDto,
  WorkflowActionUnavailableReason,
} from '../api/types';

/**
 * Fixtures for the `GET /api/queue/actions` payload.
 *
 * Every edge is a plain status change ("Ubah Status") with an `actionLabel` —
 * the per-edge `action` flag that used to distinguish a status change from a
 * category move is gone. "Pindah Kategori" (FR-CLR-03) is a standalone panel
 * action, not a flow edge, so it never appears in this surface.
 */

/** One transition exactly as the server sends it. */
export function edge(
  from: string,
  to: string,
  actionLabel: string,
  unavailableReason: WorkflowActionUnavailableReason | null = null,
): WorkflowActionDto {
  return { from, to, actionLabel, unavailableReason };
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

/** The PRD §7 default flow. Every edge is a plain status change. */
export const PRD_DEFAULT_WORKFLOW: WorkflowActionsDto = workflowActions(
  edge('WAITING', 'CALLING', 'Panggil Berikutnya'),
  edge('CALLING', 'SERVING', 'Mulai Melayani'),
  edge('CALLING', 'SKIPPED', 'Lewati / Absen'),
  edge('SKIPPED', 'CALLING', 'Panggil Ulang'),
  edge('SERVING', 'COMPLETED', 'Selesai Layan'),
);