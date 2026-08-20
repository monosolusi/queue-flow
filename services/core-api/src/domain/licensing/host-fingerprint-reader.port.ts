export const HOST_FINGERPRINT_READER = Symbol('HOST_FINGERPRINT_READER');

/**
 * Reads this machine's host claims (DIP). Keeps `node:fs` — forbidden in
 * `src/domain/` — out of the domain, exactly like the crypto port.
 *
 * Contract the implementation must honour:
 *
 * - Values are ALREADY hashed as `sha256("<name>:<rawValue>")`, lowercase hex,
 *   so no raw hardware identifier ever reaches a licence file or a log.
 * - A raw value is included only if `isUsableClaimValue` accepts it. Firmware
 *   placeholders must be OMITTED, never hashed — a digest of `"Default string"`
 *   is indistinguishable from a real serial and would make every unit of a
 *   model match every other one.
 * - **Never throws and never rejects.** A missing bind-mount, a non-Linux host,
 *   or a permission error yields an empty map, which the policy reads as
 *   UNAVAILABLE and does not block on. Failing here would take down a store
 *   over a misconfigured volume.
 */
export interface IHostFingerprintReader {
  read(): Promise<Readonly<Record<string, string>>>;
}
