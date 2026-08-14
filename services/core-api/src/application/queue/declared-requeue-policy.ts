import type { StatusValue, TransitionGraph } from '../../domain/queue';
import { type RequeuePolicy, DEFAULT_REQUEUE_POLICY } from '../../domain/shared';

/**
 * Reads what the manager declared a `-> WAITING` edge does to the WAITING
 * queue's order — the {@link RequeuePolicy} attached to the edge. Returns
 * {@link DEFAULT_REQUEUE_POLICY} (KEEP) when the edge is absent or carries no
 * policy: a pre-existing configuration has no `requeuePolicy` key, so every
 * such edge means KEEP — a re-queue leaves the ticket in its current FIFO slot
 * exactly as before (backward-compat). Belt-and-suspenders: the
 * `StateTransitionRule` VO already defaults a missing policy to KEEP, so the
 * graph never carries an `undefined` policy; the `??` here covers a future
 * narrowing decorator that drops the field.
 *
 * Applies to any edge whose target is WAITING — every `-> WAITING` edge is a
 * re-queue (the standalone "pindah kategori" counter action is not a flow edge;
 * see {@link StateTransitionRule}).
 */
export function declaredRequeuePolicyFor(
  graph: TransitionGraph,
  from: StatusValue,
  to: StatusValue,
): RequeuePolicy {
  return (
    graph.transitions.find((t) => t.from === from && t.to === to)?.requeuePolicy ??
    DEFAULT_REQUEUE_POLICY
  );
}