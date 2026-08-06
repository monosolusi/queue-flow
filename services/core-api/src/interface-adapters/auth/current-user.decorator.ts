import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../../domain/identity';

/**
 * Extracts the {@link AuthenticatedPrincipal} attached by {@link AuthGuard}
 * (or {@link AdminOrSetupGuard}) onto `req.user`. Use as a controller param
 * decorator: `reset(@CurrentUser() user: AuthenticatedPrincipal)`. The
 * principal's `username` is the source for the audit `actor`; `role` drives
 * authorization. Throws if no principal is attached (a programming error —
 * every route using this must be behind `AuthGuard`).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedPrincipal => {
    const request = ctx.switchToHttp().getRequest();
    const principal = request.user as AuthenticatedPrincipal | undefined;
    if (!principal) {
      throw new Error(
        '@CurrentUser() used on a route not guarded by AuthGuard/AdminOrSetupGuard — no principal on req.user',
      );
    }
    return principal;
  },
);