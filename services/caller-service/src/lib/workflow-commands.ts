import type { ICallerApi } from '../api/caller-api';
import type { WorkflowAction } from './workflow-actions';

/**
 * The side-effect half of the workflow derivation: executes a
 * {@link WorkflowAction} whose command **the server** already resolved (it
 * arrives on the wire in `WorkflowActionDto.command`). This is the command →
 * endpoint mapping only — the panel never decides *which* command an edge gets.
 * Kept out of the pure presentation module (which stays framework- and IO-free)
 * and out of the components (which would otherwise each duplicate it — the
 * action panel and the waiting list both need it).
 *
 * The counter-level `call-next` is deliberately NOT handled here: it targets the
 * bound counter rather than a ticket, so its single call site issues it
 * directly.
 */
export function invokeWorkflowAction(
  api: ICallerApi,
  action: WorkflowAction,
  ticketId: string,
  targetCategoryId?: string,
): Promise<void> {
  switch (action.command) {
    case 'SERVE':
      return api.serve(ticketId);
    case 'COMPLETE':
      return api.complete(ticketId);
    case 'SKIP':
      return api.skip(ticketId);
    case 'RECALL':
      return api.recall(ticketId);
    // The `CALLING → CALLING` self-loop: repeat the TV/audio announcement, no
    // state change (the endpoint hard-requires CALLING, matching the edge).
    case 'REANNOUNCE':
      return api.reannounce(ticketId);
    case 'APPLY_TRANSITION':
      return api.applyTransition(ticketId, action.to);
    case 'TRANSFER':
      // The destination is chosen by the UI (auto-picked when the counter serves
      // exactly one other category, otherwise from the chooser); without one
      // there is nothing to transfer to.
      if (!targetCategoryId) {
        return Promise.reject(new Error('Pilih kategori tujuan terlebih dahulu.'));
      }
      return api.transfer(ticketId, targetCategoryId);
    default:
      // 'CALL_NEXT' (counter-level, issued directly) or null (unroutable, or a
      // command newer than this build — `toAction` coerces those to null, so
      // their buttons are disabled). Reaching here means a caller bypassed the
      // guard; fail loudly rather than guess an endpoint.
      return Promise.reject(new Error('Aksi ini tidak bisa dijalankan dari panel loket.'));
  }
}
