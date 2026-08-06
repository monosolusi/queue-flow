import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedPrincipal } from '../../domain/identity';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/**
 * Authorization guard (QUE-43). Reads the `@Roles(...)` metadata and confirms
 * the principal attached by {@link AuthGuard} (`req.user`) has one of the
 * permitted roles. Rejects with 403 (`ForbiddenException`) on a role mismatch.
 * A route with no `@Roles` metadata requires only authentication (any role) —
 * `AuthGuard` has already ensured a principal exists. A {@link Public} route is
 * skipped entirely.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // No @Roles → only authentication required (AuthGuard handled that).
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const principal = request.user as AuthenticatedPrincipal | undefined;
    if (!principal) {
      // AuthGuard ran first and attached a principal; reaching here without one
      // means the route is misconfigured (missing AuthGuard) — deny hard.
      return false;
    }
    if (!required.includes(principal.role)) {
      throw new ForbiddenException(`Role '${principal.role}' is not permitted on this endpoint`);
    }
    return true;
  }
}