import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GetSessionUserUseCase } from '../../application/identity';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Extracts the bearer token from an `Authorization: Bearer <token>` header.
 * Returns `null` when the header is absent or not a bearer scheme.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  const token = parts[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Authentication guard (QUE-43). On every protected request, reads the
 * `Authorization: Bearer <token>` header, resolves the {@link
 * AuthenticatedPrincipal} via {@link GetSessionUserUseCase} (hash the token →
 * active session → user), and attaches it to `req.user` for `@CurrentUser()`
 * and {@link RolesGuard}. Rejects with 401 (`UnauthorizedException`) when the
 * token is missing, malformed, expired, or bound to a deleted user.
 *
 * A route marked {@link Public} is skipped entirely (kiosk/tv reads, login,
 * health, setup-status, the TV board read). Depends on
 * {@link GetSessionUserUseCase} (a framework-free use case) + the core
 * `Reflector` for metadata — no framework/ORM import beyond Nest itself (this
 * is the interface-adapter layer).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly getSessionUser: GetSessionUserUseCase,
    private readonly reflector: Reflector,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = extractBearerToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const principal = await this.getSessionUser.execute({ token });
    if (!principal) {
      throw new UnauthorizedException('Invalid or expired session token');
    }
    request.user = principal;
    return true;
  }
}