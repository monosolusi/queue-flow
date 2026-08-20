import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  LICENSE_STATUS_PROVIDER,
  type ILicenseStatusProvider,
} from '../../domain/licensing/license-status-provider.port';
import { restrictsNewTickets } from '../../domain/licensing/license-status';
import { isEnforcementDisabled } from '../../infrastructure/licensing/enforcement-switch';
import { DRAIN_CRITICAL_KEY } from './drain-critical.decorator';

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The real licence enforcement point.
 *
 * Registered as an `APP_GUARD`, so it runs BEFORE any controller-level
 * `@UseGuards` — which is what "check the licence before touching anything"
 * actually requires. The gateway's `auth_request` is the UX half of this (it
 * redirects a browser to the activation screen); this is the half that cannot
 * be walked around by pointing a client straight at `core-api-service:3000` on
 * the LAN, which the gateway alone would not stop.
 *
 * Reads are never blocked, in any state. A restricted store must still render
 * its board and its admin screens — a licence dispute is not a reason to hide a
 * shop's own data from it.
 *
 * Mutations fail CLOSED: anything not named in {@link DRAIN_CRITICAL_MUTATIONS}
 * is refused while RESTRICTED. A mutating endpoint added later is therefore
 * covered by default and has to be opted in deliberately, rather than being
 * silently exempt because nobody remembered this file existed.
 */
@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(
    @Inject(LICENSE_STATUS_PROVIDER) private readonly licenseStatus: ILicenseStatusProvider,
    private readonly reflector: Reflector,
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    // WebSocket and other non-HTTP contexts are out of scope: the WS surface is
    // read-only broadcast, and there is nothing to withhold on it.
    if (context.getType() !== 'http') return true;

    if (isEnforcementDisabled()) return true;

    // Untyped, like the other guards in this repo: `express` is only a
    // transitive dependency here, and both dep-cruiser (`no-non-package-json`)
    // and tsc reject importing its types directly.
    const request: { method?: string } = context.switchToHttp().getRequest();

    // Reads first: a restricted store must still render its board and its admin
    // screens. A licence dispute is not a reason to hide a shop's own data.
    if (!MUTATING_METHODS.has(request.method ?? 'GET')) return true;

    const status = this.licenseStatus.current;
    // Still evaluating at boot. Allowing through beats turning a slow database
    // into a licence outage; the refresh completes within a second or two.
    if (status === null) return true;
    // The DOMAIN decides what "restricted" means. Comparing against the enum
    // here would mean a sixth state that also restricts gets added to the
    // domain while this guard keeps waving traffic through.
    if (!restrictsNewTickets(status)) return true;

    if (
      this.reflector.getAllAndOverride<boolean>(DRAIN_CRITICAL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }

    throw new ForbiddenException({
      code: 'LICENSE_REQUIRED',
      licenseState: status.state,
      licenseIssue: status.issue,
      message: status.detail,
    });
  }
}
