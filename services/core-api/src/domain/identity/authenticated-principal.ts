import type { Role } from './value-objects/role';

/**
 * The authenticated principal attached to `req.user` by `AuthGuard` and read
 * back by the `@CurrentUser()` param decorator. Transport-agnostic (no
 * framework import) — the guard maps it onto the Nest request in the
 * interface-adapter layer. `userId` is the UUID; `username` is what the audit
 * `actor` is sourced from; `role` drives `RolesGuard`.
 */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
}