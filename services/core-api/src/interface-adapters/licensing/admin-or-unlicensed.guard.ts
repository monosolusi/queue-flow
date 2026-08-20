import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { GetSessionUserUseCase } from '../../application/identity';
import {
  LICENSE_STATUS_PROVIDER,
  type ILicenseStatusProvider,
} from '../../domain/licensing/license-status-provider.port';
import { restrictsNewTickets } from '../../domain/licensing/license-status';
import { extractBearerToken } from '../auth/auth.guard';

/**
 * Guards `POST /api/license` — the activation endpoint, which has the same
 * two-legitimate-callers shape as `PUT /api/system/config`.
 *
 * A brand-new mini PC has neither a licence nor an admin user: the licence gate
 * comes before the setup wizard, so no account exists yet to authenticate with.
 * If activation required an admin, the store could never leave the state it is
 * stuck in. So:
 *
 * - Store is RESTRICTED (unlicensed) → **allow** unauthenticated. This is the
 *   bootstrap escape hatch, exactly like {@link AdminOrSetupGuard}'s. The audit
 *   actor falls back to the `'system'` sentinel.
 * - Otherwise → require an authenticated `admin`. Once a store is licensed and
 *   staffed, replacing its licence is an administrative act.
 *
 * The escape hatch is not a hole worth worrying about: the only thing it lets an
 * unauthenticated LAN client do is install a **validly signed** licence, and
 * anyone able to mint one of those does not need this endpoint.
 */
@Injectable()
export class AdminOrUnlicensedGuard implements CanActivate {
  constructor(
    private readonly getSessionUser: GetSessionUserUseCase,
    @Inject(LICENSE_STATUS_PROVIDER) private readonly licenseStatus: ILicenseStatusProvider,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const status = this.licenseStatus.current;

    // `null` means the first evaluation has not finished. Treat the boot window
    // as unlicensed rather than as licensed: the permissive reading here only
    // widens who may upload a correctly signed file.
    if (status === null || restrictsNewTickets(status)) {
      // Resolve the principal anyway, best-effort. The common case is NOT
      // first-run: a licence lapses past grace after two years, an admin logs
      // in (login stays reachable) and re-activates. Returning early without
      // attaching `req.user` made the controller fall back to the `'system'`
      // sentinel, so NFR-SEC-02's "actor is the authenticated principal's
      // username" was silently violated for the most likely real activation —
      // and LICENSE_ACTIVATED is the only local record of that commercial act.
      // Never throws: an absent or stale token must not block the bootstrap.
      await this.attachPrincipalIfPresent(request);
      return true;
    }

    const token = extractBearerToken(request.headers?.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const principal = await this.getSessionUser.execute({ token });
    if (!principal) {
      throw new UnauthorizedException('Invalid or expired session token');
    }
    if (principal.role !== 'admin') {
      throw new ForbiddenException('Only an admin may replace the license');
    }
    request.user = principal;
    return true;
  }

  private async attachPrincipalIfPresent(request: {
    headers?: { authorization?: string };
    user?: unknown;
  }): Promise<void> {
    const token = extractBearerToken(request.headers?.authorization);
    if (!token) return;
    try {
      const principal = await this.getSessionUser.execute({ token });
      if (principal) request.user = principal;
    } catch {
      // A malformed or expired token on the bootstrap path is not an error —
      // the upload is allowed either way; only the audit actor is affected.
    }
  }
}
