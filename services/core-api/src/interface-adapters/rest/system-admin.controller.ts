import { Body, Controller, Inject, Post } from '@nestjs/common';
import { CleanupTransactionLogUseCase, ResetDailyQueueUseCase } from '../../application/queue';
import {
  SYSTEM_CONFIGURATION_REPOSITORY,
  type ISystemConfigurationRepository,
} from '../../domain/store-config';
import { SystemNotConfiguredException } from '../../domain/shared';

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
export class SystemAdminController {
  constructor(
    private readonly resetDailyQueue: ResetDailyQueueUseCase,
    private readonly cleanupTransactionLog: CleanupTransactionLogUseCase,
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly config: ISystemConfigurationRepository,
  ) {}

  /** `POST /api/system/daily-reset` → roll the sequence back to the configured start. */
  @Post('daily-reset')
  async reset() {
    const system = await this.config.get();
    if (!system) {
      throw new SystemNotConfiguredException();
    }
    const policy = system.dailyResetPolicy;
    // `actor` marks this as a manual, human-triggered reset so the use case
    // records a `MANUAL_RESET` audit entry (NFR-SEC-02). The automatic
    // cron-driven reset omits `actor` and is therefore not audited.
    // `archivePreviousDay` translates `DailyResetPolicy.archivePreviousDayData`
    // (FR-WZD-05 / QUE-16) — prior-day tickets are relocated to the archive
    // store before the sequence reset.
    return this.resetDailyQueue.execute({
      resetTo: policy.resetTicketNumberTo,
      archivePreviousDay: policy.archivePreviousDayData,
      actor: 'admin',
    });
  }

  /**
   * `POST /api/system/cleanup-transaction-log` → permanently delete archived
   * transactions older than `retentionDays` (QUE-25 / FR-ADM-02). `actor` marks
   * this as a manual, human-triggered cleanup so the use case records a
   * `TRANSACTION_LOG_CLEANUP` audit entry (NFR-SEC-02). The `audit_log` table is
   * never touched — only `archived_tickets`.
   */
  @Post('cleanup-transaction-log')
  async cleanup(@Body() body: CleanupTransactionLogRequestDto) {
    return this.cleanupTransactionLog.execute({
      retentionDays: body?.retentionDays,
      actor: 'admin',
    });
  }
}