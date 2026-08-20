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

import {
  ActivateLicenseUseCase,
  GetActivationRequestUseCase,
  type ActivationRequestDto,
} from '../../application/licensing';
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

/** Largest licence file accepted. A real one is well under 2 KB. */
const MAX_TOKEN_BYTES = 16 * 1024;

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
  token?: unknown;
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
    private readonly getActivationRequest: GetActivationRequestUseCase,
    @Inject(LICENSE_REPOSITORY) private readonly licenses: ILicenseRepository,
  ) {}

  /** Current verdict. Served from the cache, so it is cheap enough to poll. */
  @Get()
  async status(): Promise<LicenseStatusDto> {
    const status = this.licenseStatus.current ?? (await this.licenseState.refresh());
    return licenseStatusToDto(status);
  }

  /**
   * The blob the customer sends the vendor to have a licence issued.
   *
   * Guarded by the same bootstrap rule as the upload — open while the store is
   * RESTRICTED (there is no account yet on a fresh mini PC), admin-only once it
   * is licensed. It carries the host claim DIGESTS, and `license-status.dto.ts`
   * deliberately withholds those from the status projection on the grounds that
   * publishing them hands anyone building a clone the exact values to
   * reproduce. Serving them unauthenticated forever, from a licensed store,
   * would have contradicted that outright.
   */
  @Get('activation-request')
  @UseGuards(AdminOrUnlicensedGuard)
  async activationRequest(): Promise<ActivationRequestDto> {
    return this.getActivationRequest.execute();
  }

  /**
   * Installs an uploaded licence.
   *
   * A rejected file answers 400 with a machine-readable `reason` rather than a
   * generic error: the screen renders different Indonesian copy for "this is
   * not a licence file", "this was issued for another machine", and "this was
   * not signed by us", and those need three different remediations.
   */
  @Post()
  @HttpCode(200)
  @DrainCritical()
  @UseGuards(AdminOrUnlicensedGuard)
  async activate(
    @Body() body: ActivateLicenseBody,
    @Req() request: HttpRequestWithPrincipal,
  ): Promise<LicenseStatusDto> {
    const token = body?.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new BadRequestException({ code: 'LICENSE_MISSING', message: 'token is required' });
    }
    if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      // The endpoint is reachable unauthenticated on an unlicensed store, so it
      // needs its own bound — a signature check on a multi-megabyte body is a
      // free way to make the box work.
      throw new BadRequestException({ code: 'LICENSE_TOO_LARGE', message: 'license file is too large' });
    }

    const result = await this.activateLicense.execute({
      token,
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
    // successful upload.
    await this.licenseState.refresh();
    return licenseStatusToDto(result.status);
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
