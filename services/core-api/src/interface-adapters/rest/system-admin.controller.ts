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
 * passes only the scalar `resetTo` into the use case command, so the use case
 * stays free of any Store-Config import.
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
    const resetTo = system.dailyResetPolicy.resetTicketNumberTo;
    return this.resetDailyQueue.execute({ resetTo });
  }
}