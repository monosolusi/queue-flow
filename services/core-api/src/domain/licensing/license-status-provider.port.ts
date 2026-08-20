import type { LicenseStatus } from './license-status';

export const LICENSE_STATUS_PROVIDER = Symbol('LICENSE_STATUS_PROVIDER');

/**
 * Read port for the current licence verdict (DIP).
 *
 * The guards and controllers that enforce licensing must not bind to
 * `LicenseStateService` — that concretion owns `@Injectable`, a `Logger`, an
 * `OnApplicationBootstrap` hook and a `setInterval`, none of which an
 * enforcement point has any business knowing about. Depending on this port
 * instead also makes those guards unit-testable without booting Nest.
 *
 * Synchronous on purpose: the verdict is consulted on every mutating request
 * and on the gateway's access-check subrequest, so it has to be an in-memory
 * read. Awaiting IO here is what the caching implementation exists to avoid.
 *
 * `null` means the first evaluation has not landed yet (the boot window). It is
 * NOT "restricted" — treating an unresolved verdict as a denial would turn a
 * slow database into a licence outage.
 */
export interface ILicenseStatusProvider {
  readonly current: LicenseStatus | null;
}
