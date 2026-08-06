import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { CleanupTransactionLogUseCase, ResetDailyQueueUseCase } from '../../application/queue';
import {
  SYSTEM_CONFIGURATION_REPOSITORY,
  type ISystemConfigurationRepository,
} from '../../domain/store-config';
import { SystemNotConfiguredException } from '../../domain/shared';
import { Role, type AuthenticatedPrincipal } from '../../domain/identity';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

/**
 * The body of `POST /api/system/cleanup-transaction-log` (QUE-25 / FR-ADM-02).
 * The manager picks a retention window; archived transactions older than that
 * window are permanently deleted. A `retentionDays` below the domain-enforced
 * floor is rejected by the use case with `InvalidArgumentException` → 400
 * (mapped by the global {@link DomainExceptionFilter}) before any row is purged.
 */
export interface CleanupTransactionLogRequestDto {
  readonly retentionDays: number;
}

/**
 * System-admin REST surface (FR-ENG-05 / QUE-2, FR-ADM-02 / QUE-25). Exposes the
 * manual daily-reset trigger — the `MANUAL` mode of {@link DailyResetPolicy} and
 * ad-hoc resets during operations both flow through here — and the
 * transaction-log cleanup override. This is the anti-corruption translation
 * point: the controller reads the active `DailyResetPolicy` (Store-Config) and
 * passes only scalars (`resetTo`, `archivePreviousDay`) into the reset use case,
 * and threads the scalar `retentionDays` + `actor` into the cleanup use case, so
 * neither use case imports Store-Config.
 *
 * The global {@link DomainExceptionFilter} maps `SystemNotConfiguredException`
 * (no config yet) to 409 and `InvalidArgumentException` (under-floor retention)
 * to 400.
 */
@Controller('api/system')
@UseGuards(AuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SystemAdminController {
  constructor(
    private readonly resetDailyQueue: ResetDailyQueueUseCase,
    private readonly cleanupTransactionLog: CleanupTransactionLogUseCase,
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly config: ISystemConfigurationRepository,
  ) {}

  /** `POST /api/system/daily-reset` → roll the sequence back to the configured start. */
  @Post('daily-reset')
  async reset(@CurrentUser() principal: AuthenticatedPrincipal) {
    const system = await this.config.get();
    if (!system) {
      throw new SystemNotConfiguredException();
    }
    const policy = system.dailyResetPolicy;
    // `actor` is the authenticated admin's username (QUE-43) — it marks this as
    // a manual, human-triggered reset so the use case records a `MANUAL_RESET`
    // audit entry attributing the *actual* operator (NFR-SEC-02), replacing the
    // former hardcoded `'admin'` literal (a forgery vector). The automatic
    // cron-driven reset omits `actor` and is therefore not audited.
    // `archivePreviousDay` translates `DailyResetPolicy.archivePreviousDayData`
    // (FR-WZD-05 / QUE-16) — prior-day tickets are relocated to the archive
    // store before the sequence reset.
    return this.resetDailyQueue.execute({
      resetTo: policy.resetTicketNumberTo,
      archivePreviousDay: policy.archivePreviousDayData,
      actor: principal.username,
    });
  }

  /**
   * `POST /api/system/cleanup-transaction-log` → permanently delete archived
   * transactions older than `retentionDays` (QUE-25 / FR-ADM-02). `actor` is the
   * authenticated admin's username (QUE-43) — it marks this as a manual,
   * human-triggered cleanup so the use case records a `TRANSACTION_LOG_CLEANUP`
   * audit entry attributing the actual operator (NFR-SEC-02), replacing the
   * former hardcoded `'admin'` literal. The `audit_log` table is never touched
   * — only `archived_tickets`.
   */
  @Post('cleanup-transaction-log')
  async cleanup(
    @Body() body: CleanupTransactionLogRequestDto,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.cleanupTransactionLog.execute({
      retentionDays: body?.retentionDays,
      actor: principal.username,
    });
  }
}