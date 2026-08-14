import type { ICallerApi } from '../api/caller-api';
import type { WorkflowAction } from './workflow-actions';

/** What a workflow action needs from the panel to run: the counter it is being
 *  run at, and — for a category move — the destination the staff picked. */
export interface WorkflowActionContext {
  /** The panel's bound counter. A transition into CALLING announces the ticket
   *  there; every other target ignores it. */
  readonly counterId?: number;
  /** Chosen by the UI (auto-picked when the counter serves exactly one other
   *  category, otherwise from the chooser). Required for a category move. */
  readonly targetCategoryId?: string;
}

/**
 * The side-effect half of the workflow derivation: executes a
 * {@link WorkflowAction} by the action the **manager declared** for it, which
 * arrives on the wire in `WorkflowActionDto.action`.
 *
 * This is an action → endpoint mapping, and nothing more. It is deliberately not
 * a `(from, to)` → endpoint table: the backend used to keep one of those and it
 * could not help guessing — every edge into WAITING was executed as a category
 * move, so a flow drawn to re-queue a ticket demanded a destination category.
 * Which endpoint runs an edge now follows from one declared value, and there is
 * exactly one endpoint for a status change whatever the target state is.
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
  switch (action.action) {
    case 'UPDATE_STATUS':
      // One endpoint for every target the flow allows — canonical or custom. The
      // side effects of arriving in that state (announcement, service clock,
      // re-queue) belong to core-api's aggregate, not to a choice made here.
      return api.applyTransition(ticketId, action.to, context.counterId);
    case 'TRANSFER_CATEGORY':
      if (!context.targetCategoryId) {
        return Promise.reject(new Error('Pilih kategori tujuan terlebih dahulu.'));
      }
      // No target status: a transferred ticket always lands back in the queue,
      // because it gets a new per-category number. The edge's `to` carries no
      // extra information here — core-api rejects a category move declared on an
      // edge that targets anything else, at save time.
      return api.transfer(ticketId, context.targetCategoryId);
    default:
      // `null` — an edge the server marked unrunnable, or one whose action is
      // newer than this build (`toAction` coerces those to null, so their buttons
      // are disabled). Reaching here means a caller bypassed the guard; fail
      // loudly rather than guess an endpoint.
      return Promise.reject(new Error('Aksi ini tidak bisa dijalankan dari panel loket.'));
  }
}
