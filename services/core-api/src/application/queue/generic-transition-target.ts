import { isCanonicalStatus, type StatusValue } from '../../domain/queue';

/**
 * The admission rule of the **generic** transition command
 * (`ApplyTransitionUseCase`, exposed as `POST /api/queue/:ticketId/transition`):
 * it accepts only a **custom** (non-canonical) target state — PREPARING,
 * PAYMENT, … — and rejects the five canonical ones with a 400.
 *
 * Each canonical target has a dedicated command endpoint whose aggregate method
 * owns the domain-specific side effects (lifecycle timestamps, counter/number
 * reassignment); routing one through the generic path would silently corrupt the
 * QUE-26 analytics data model (a `COMPLETED` reached that way leaves
 * `completedAt` null).
 *
 * Extracted here because the rule has **two** enforcers that must never drift:
 *
 * 1. `QueueCommandsController.transition` — enforces it (400 on a canonical
 *    target).
 * 2. `GetWorkflowActionsUseCase` — *predicts* it, resolving an edge to the
 *    `APPLY_TRANSITION` command only for targets the endpoint would accept.
 *
 * Sharing `isCanonicalStatus` alone was not enough: the two sites shared the
 * predicate but each restated the rule, so relaxing the controller's guard would
 * leave the resolution table steering those targets away from
 * `APPLY_TRANSITION` with nothing failing. One named function means the rule
 * changes in one place.
 *
 * Lives in the application layer (next to the use case whose contract it is) so
 * both the interface-adapter controller and the read-side use case can import it
 * without inverting the dependency direction — interface-adapters may depend on
 * application, never the reverse.
 */
export function acceptsGenericTransitionTarget(target: StatusValue): boolean {
  return !isCanonicalStatus(target);
}
