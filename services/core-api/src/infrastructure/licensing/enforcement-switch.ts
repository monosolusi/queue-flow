/**
 * The single place that decides whether licensing is enforced at all.
 *
 * Shared, not duplicated, because "enforced" has to mean the same thing to
 * every enforcement point. The guard and the entitlement-cap composition both
 * consult it: a build where the guard waves `PUT /api/system/config` through
 * but the caps still reject it would be worse than either behaviour alone —
 * the store would look configurable and then refuse the save.
 *
 * Local-development and test escape hatch. Requires `NODE_ENV !== 'production'`,
 * which the Dockerfile pins, so it does nothing in a shipped image as
 * configured. It is NOT a wall: `docker-compose.yml` belongs to the customer
 * and can override `NODE_ENV`. Anyone willing to do that is already willing to
 * edit the JavaScript in the image, so this adds no meaningful attack surface —
 * see docs/LICENSE-SERVER-CONTRACT.md.
 */
export function isEnforcementDisabled(): boolean {
  return process.env.QMS_LICENSE_ENFORCEMENT === 'off' && process.env.NODE_ENV !== 'production';
}
