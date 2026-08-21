import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ActivateLicenseUseCase } from '../../application/licensing';
import {
  licenseStatusToDto,
  type LicenseStatusDto,
} from '../../application/licensing/license-status.dto';
import { Role } from '../../domain/identity/value-objects/role';
import {
  LICENSE_REPOSITORY,
  type ILicenseRepository,
} from '../../domain/licensing/repositories/license.repository';
import {
  LICENSE_STATUS_PROVIDER,
  type ILicenseStatusProvider,
} from '../../domain/licensing/license-status-provider.port';
import { LicenseStateService } from '../../infrastructure/licensing/license-state.service';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdminOrUnlicensedGuard } from './admin-or-unlicensed.guard';
import { DrainCritical } from './drain-critical.decorator';

/**
 * Largest activation key accepted. A real one is 23 characters; the slack is
 * for the spaces and line wraps a key picks up on its way through a chat app.
 * The endpoint is reachable unauthenticated on an unlicensed store, so it needs
 * its own bound rather than relying on the body parser's.
 */
const MAX_KEY_BYTES = 256;

/**
 * The principal, when there is one. `@CurrentUser()` is deliberately NOT used
 * here: it throws when nothing is attached, and the whole point of
 * {@link AdminOrUnlicensedGuard} is that an unlicensed store activates WITHOUT
 * authenticating — so the absent case is the normal first-run path, not a
 * programming error. Mirrors `SystemConfigController.save`.
 */
interface HttpRequestWithPrincipal {
  user?: { username?: string };
}

interface ActivateLicenseBody {
  key?: unknown;
}

interface LicenseHistoryEntryDto {
  id: string;
  installedAt: string;
  installedBy: string;
  isActive: boolean;
}

/**
 * The licence surface.
 *
 * `GET` routes are unauthenticated on purpose: the activation screen is the
 * ONLY screen reachable on an unlicensed store, and it has to render the
 * installation id before any account exists to log in with. Nothing here
 * exposes more than the LAN can already see, and the claim digests are withheld
 * from the projection.
 */
@Controller('api/license')
export class LicenseController {
  constructor(
    // The write side (refresh-after-activation) genuinely needs the concretion;
    // the read side goes through the port.
    @Inject(LICENSE_STATUS_PROVIDER) private readonly licenseStatus: ILicenseStatusProvider,
    private readonly licenseState: LicenseStateService,
    private readonly activateLicense: ActivateLicenseUseCase,
    @Inject(LICENSE_REPOSITORY) private readonly licenses: ILicenseRepository,
  ) {}

  /** Current verdict. Served from the cache, so it is cheap enough to poll. */
  @Get()
  async status(): Promise<LicenseStatusDto> {
    const status = this.licenseStatus.current ?? (await this.licenseState.refresh());
    return licenseStatusToDto(status, this.licenseState.installationId);
  }

  /**
   * Redeems an activation key.
   *
   * There is no "install this token" counterpart. Accepting a token directly
   * would be an offline activation path in all but name, and the product
   * deliberately has none: redeeming through the activation server is what
   * stops one key from quietly running four branches. Everything a token needs
   * to be trusted still applies to what comes back — this endpoint is the only
   * door, not a shortcut around the lock.
   *
   * A rejection answers 400 with a machine-readable `reason` rather than a
   * generic error. "There is no internet here", "this key belongs to another
   * device" and "this key is mistyped" are three different problems with three
   * different remedies, and the screen renders different Indonesian copy for
   * each.
   */
  @Post('activate')
  @HttpCode(200)
  @DrainCritical()
  @UseGuards(AdminOrUnlicensedGuard)
  async activate(
    @Body() body: ActivateLicenseBody,
    @Req() request: HttpRequestWithPrincipal,
  ): Promise<LicenseStatusDto> {
    const key = body?.key;
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new BadRequestException({ code: 'LICENSE_MISSING', message: 'key is required' });
    }
    if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
      throw new BadRequestException({ code: 'LICENSE_TOO_LARGE', message: 'activation key is too long' });
    }

    const result = await this.activateLicense.execute({
      key,
      // No principal exists on the pre-setup activation path; NFR-SEC-02's
      // `'system'` sentinel covers it, exactly as the wizard's config save does.
      actor: request.user?.username ?? 'system',
    });

    if (!result.ok) {
      throw new BadRequestException({
        code: 'LICENSE_REJECTED',
        reason: result.reason,
        message: result.detail,
      });
    }

    // Publish the new verdict immediately rather than waiting for the refresh
    // interval, so the screen never shows "not licensed" straight after a
    // successful activation.
    await this.licenseState.refresh();
    return licenseStatusToDto(result.status, this.licenseState.installationId);
  }

  /** Activation history. Admin-only — it names who installed what and when. */
  @Get('history')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  async history(): Promise<LicenseHistoryEntryDto[]> {
    const rows = await this.licenses.history();
    return rows.map((row) => ({
      id: row.id,
      installedAt: row.installedAt.toISOString(),
      installedBy: row.installedBy,
      isActive: row.isActive,
      // The token is deliberately not projected: it is the bearer credential
      // for this entitlement, and a history screen has no use for it.
    }));
  }
}
