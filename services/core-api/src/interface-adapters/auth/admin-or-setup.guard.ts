import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GetSetupStatusUseCase } from '../../application/store-config';
import { GetSessionUserUseCase } from '../../application/identity';

/**
 * Guards `PUT /api/system/config` — the one endpoint that has two legitimate
 * callers: the **first-run wizard** (no session yet — setup incomplete) and an
 * **authenticated admin** (post-setup). Either is allowed; anything else is
 * rejected.
 *
 * - If `isInitialSetupCompleted` is false → **allow** (the wizard is mid-setup;
 *   no principal is attached, and the controller's actor defaults to the
 *   `'system'` sentinel). This is the bootstrap escape hatch: the wizard must
 *   be able to save config before any user exists.
 * - Else → require an authenticated `admin` session: resolve the bearer token
 *   via {@link GetSessionUserUseCase} (401 if missing/invalid/expired), then
 *   check the role is `admin` (403 otherwise). The principal is attached to
 *   `req.user` so the controller's `@CurrentUser()` yields the real username
 *   for the audit `actor`.
 *
 * Anti-corruption: the guard reads setup status through the existing
 * {@link GetSetupStatusUseCase} (Store-Config) — it imports no Store-Config
 * domain type, only the use case. Mirrors `SystemAdminController` reading
 * `DailyResetPolicy` at the controller boundary.
 */
@Injectable()
export class AdminOrSetupGuard implements CanActivate {
  constructor(
    private readonly getSessionUser: GetSessionUserUseCase,
    private readonly getSetupStatus: GetSetupStatusUseCase,
    private readonly reflector: Reflector,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const { isInitialSetupCompleted } = await this.getSetupStatus.execute();
    if (!isInitialSetupCompleted) {
      // First-run wizard path — no principal; controller uses the 'system'
      // sentinel as the audit actor.
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;
    const parts = authHeader?.split(' ');
    const token = parts?.length === 2 && parts[0].toLowerCase() === 'bearer'
      ? parts[1].trim()
      : null;
    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const principal = await this.getSessionUser.execute({ token });
    if (!principal) {
      throw new UnauthorizedException('Invalid or expired session token');
    }
    if (principal.role !== 'admin') {
      throw new ForbiddenException('Only an admin may change system configuration post-setup');
    }
    request.user = principal;
    return true;
  }
}