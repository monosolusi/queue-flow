import { SetMetadata } from '@nestjs/common';
import type { Role } from '../../domain/identity';

/** Metadata key carrying the {@link Role}s allowed by `@Roles(...)`. */
export const ROLES_KEY = 'roles';

/**
 * Declares the roles permitted on a route (read by {@link RolesGuard}). Combine
 * with `@UseGuards(AuthGuard, RolesGuard)` — `AuthGuard` authenticates and
 * attaches the principal; `RolesGuard` checks the principal's role is allowed.
 * A route with no `@Roles` (but behind `AuthGuard`) requires only
 * authentication (any role). Use `@Public()` to skip both.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);