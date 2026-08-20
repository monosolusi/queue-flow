import { InvalidValueObjectException } from '../../shared/errors';

/**
 * The commercial tier a licence was sold under. Each tier answers a different
 * question about what can make the store stop working:
 *
 * - `PERPETUAL` — never expires. The purchased major version may be run
 *   forever; `supportUntil` bounds only the right to upgrade to the NEXT major
 *   version, and passing it changes nothing about how the software runs. For
 *   this tier a host mismatch is the only thing that can ever restrict a store,
 *   which is why the mismatch grace window is the longer of the two.
 * - `TRIAL` — expires on a date, then grace, then restricted.
 * - `FREE` — no end date, but capped entitlements.
 *
 * Deliberately no `SUBSCRIPTION` tier: it was considered and dropped. Adding
 * one later needs no migration — the type is a string inside a signed token,
 * and unknown values are already rejected here rather than silently accepted.
 */
export enum LicenseType {
  PERPETUAL = 'perpetual',
  TRIAL = 'trial',
  FREE = 'free',
}

// `in` on a TS string enum matches Object.prototype keys too ('toString' would
// pass), so membership is tested against a Set of the VALUES.
const LICENSE_TYPES: ReadonlySet<string> = new Set(Object.values(LicenseType));

export function licenseTypeOf(raw: unknown): LicenseType {
  if (typeof raw === 'string' && LICENSE_TYPES.has(raw)) {
    return raw as LicenseType;
  }
  throw new InvalidValueObjectException(
    `license type must be one of ${[...LICENSE_TYPES].join(' | ')}, got '${String(raw)}'`,
  );
}
