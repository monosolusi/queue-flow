import type { ICallerApi } from '../api/caller-api';
import type { WorkflowAction } from './workflow-actions';

/** What a workflow action needs from the panel to run: the counter it is being
 *  run at. A transition into CALLING announces the ticket there; every other
 *  target ignores it. */
export interface WorkflowActionContext {
  /** The panel's bound counter. */
  readonly counterId?: number;
}

/**
 * The side-effect half of the workflow derivation: runs a
 * {@link WorkflowAction} as the one status-change endpoint every flow edge
 * shares. Every edge is a plain status change now — the per-edge `action` flag
 * that used to route some edges to a category-move endpoint is gone, and
 * "Pindah Kategori" is a standalone panel action that calls `api.transfer`
 * directly (not through here).
 *
 * One endpoint for every target the flow allows, canonical or custom. The side
 * effects of arriving in that state (announcement, service clock, re-queue)
 * belong to core-api's aggregate, not to a choice made here.
 *
 * Kept out of the pure presentation module (which stays framework- and IO-free)
 * and out of the components (which would otherwise each duplicate it — the action
 * panel, the waiting list and the skipped list all need it).
 *
 * The counter-level `call-next` is deliberately NOT handled here: it targets the
 * bound counter rather than a ticket, so its single call site issues it directly.
 */
export function invokeWorkflowAction(
  api: ICallerApi,
  action: WorkflowAction,
  ticketId: string,
  context: WorkflowActionContext = {},
): Promise<void> {
  return api.applyTransition(ticketId, action.to, context.counterId);
}