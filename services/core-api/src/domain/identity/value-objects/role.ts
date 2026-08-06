import { InvalidValueObjectException } from '../../shared/errors';

/**
 * The authorization roles in the Identity bounded context (QUE-43).
 *
 * - `ADMIN` — full admin-service access (config, daily reset, cleanup, user
 *   CRUD, reports, audit log).
 * - `CALLER_STAFF` — caller-service operations (queue commands + reads).
 *
 * Kiosk and TV have **no users** and therefore no role — their endpoints stay
 * public. AuthZ is role-based only; there is no per-resource ownership model.
 */
export enum Role {
  ADMIN = 'admin',
  CALLER_STAFF = 'caller-staff',
}

export type RoleValue = `${Role}`;

/** The closed set of valid role strings (used for input validation + DB CHECK). */
export const ROLES: ReadonlySet<string> = new Set<string>(Object.values(Role));

/**
 * Coerces an untrusted string into a {@link Role}, throwing
 * {@link InvalidValueObjectException} (→ 400) on an unknown role. Use at the
 * use-case boundary so a hand-crafted role is rejected at the source rather
 * than persisted. Mirrors the source-owns-construction-failure rule.
 */
export function roleOf(value: string): Role {
  if (!ROLES.has(value)) {
    throw new InvalidValueObjectException(`unknown role '${value}'`);
  }
  return value as Role;
}