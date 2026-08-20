import { SetMetadata } from '@nestjs/common';

export const DRAIN_CRITICAL_KEY = 'license:drain-critical';

/**
 * Marks a mutating handler as reachable even while the store is RESTRICTED.
 *
 * Metadata rather than a URL allowlist inside {@link LicenseGuard}, because an
 * allowlist is a hand-copied duplicate of the routing table maintained in a
 * different file by a different concern. Rename or re-nest a route and the
 * guard silently starts refusing it — and since it fails closed, the failure
 * mode is *the counter panel dying during a licence lapse*, which is the exact
 * outcome the policy exists to prevent, at the exact moment nobody is watching.
 * The exemption now travels with the handler it exempts.
 *
 * Apply ONLY to:
 *  - the queue commands that let an existing queue drain — a shop full of
 *    people holding printed tickets must still be served; withholding NEW
 *    tickets is the lever, punishing the customers already in line is not;
 *  - the endpoints without which the store could never be activated out of the
 *    state it is stuck in (login/logout, and the licence upload itself).
 *
 * Deliberately NOT applied to `POST /api/tickets` (the lever), nor to
 * `POST /api/auth/setup-admin` — creating the first admin is part of setting up
 * a store, and configuring a store you are not licensed to run is the wrong
 * order. An earlier `^/api/auth/.*$` wildcard exempted it by accident.
 */
export const DrainCritical = (): MethodDecorator & ClassDecorator =>
  SetMetadata(DRAIN_CRITICAL_KEY, true);
