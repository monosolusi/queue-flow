import { Controller, Inject, Post } from '@nestjs/common';
import { ResetDailyQueueUseCase } from '../../application/queue';
import {
  SYSTEM_CONFIGURATION_REPOSITORY,
  type ISystemConfigurationRepository,
} from '../../domain/store-config';
import { SystemNotConfiguredException } from '../../domain/shared';

/**
 * System-admin REST surface (FR-ENG-05 / QUE-2). Exposes the manual daily-reset
 * trigger — the `MANUAL` mode of {@link DailyResetPolicy} and ad-hoc resets during
 * operations both flow through here. This is the anti-corruption translation
 * point: the controller reads the active `DailyResetPolicy` (Store-Config) and
 * passes only scalars (`resetTo`, `archivePreviousDay`) into the use case
 * command, so the use case stays free of any Store-Config import.
 *
 * The global {@link DomainExceptionFilter} maps `SystemNotConfiguredException`
 * (no config yet) to 409.
 */
@Controller('api/system')
export class SystemAdminController {
  constructor(
    private readonly resetDailyQueue: ResetDailyQueueUseCase,
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
}