/**
 * Re-exported from the shared kernel so the Store Config context keeps a stable
 * import path. The canonical definition lives in `domain/shared/priority-policy`
 * (shared kernel) to keep the Queue and Store Config contexts decoupled.
 */
export { PriorityPolicy, type PriorityPolicyValue } from '../../shared/priority-policy';