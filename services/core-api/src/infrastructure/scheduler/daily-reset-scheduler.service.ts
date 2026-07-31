import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ResetDailyQueueUseCase } from '../../application/queue';
import {
  DailyResetMode,
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../domain/store-config';

/**
 * Drives the *automatic* daily reset (FR-ENG-05 / QUE-2). Reads the active
 * {@link DailyResetPolicy} from the singleton `SystemConfiguration` at boot and,
 * when the mode is `AUTOMATIC_CRON`, arms a cron job that invokes
 * {@link ResetDailyQueueUseCase} with the policy's `resetTicketNumberTo`. The
 * use case rolls the per-category sequence back and emits the `SYSTEM_RESET`
 * event. `MANUAL` mode arms nothing — resets then flow through the
 * `POST /api/system/daily-reset` endpoint.
 *
 * The `cron` library runs expressions in the host's local time, which matches the
 * single on-premise box / local-LAN deployment (NFR-SEC-01) and the local-time
 * `toDateKey` convention the sequence key uses.
 *
 * Scope note (QUE-2): the cron is armed **once at boot**. Re-arming on a config
 * change (wizard/admin editing the cron expression or mode at runtime) is future
 * work — it pairs with the audit-trail requirement (NFR-SEC-02). Until then, a
 * policy edit takes effect on the next process restart. If no
 * `SystemConfiguration` exists at boot (pre-wizard), the scheduler stays idle;
 * the cron arms on the next restart after the wizard completes.
 *
 * Lives in infrastructure: it owns the cron I/O (a framework/timer concern), so
 * it must not live in domain or application. dep-cruiser permits infrastructure
 * → application/domain.
 */
@Injectable()
export class DailyResetSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(DailyResetSchedulerService.name);
  private static readonly CRON_NAME = 'daily-reset';

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly resetDailyQueue: ResetDailyQueueUseCase,
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly config: ISystemConfigurationRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const system = await this.config.get();
    if (!system) {
      this.logger.log('System not configured yet — daily reset scheduler idle.');
      return;
    }

    const policy = system.dailyResetPolicy;
    if (policy.mode !== DailyResetMode.AUTOMATIC_CRON || !policy.cronExpression) {
      this.logger.log(
        `Daily reset mode is '${policy.mode}' — no automatic cron armed (use POST /api/system/daily-reset).`,
      );
      return;
    }

    // Defensive: never double-register on a re-init (dev hot-reload safety).
    if (this.registry.doesExist('cron', DailyResetSchedulerService.CRON_NAME)) {
      this.registry.deleteCronJob(DailyResetSchedulerService.CRON_NAME);
    }

    const job = new CronJob(policy.cronExpression, () => {
      void this.resetDailyQueue.execute({ resetTo: policy.resetTicketNumberTo });
    });
    this.registry.addCronJob(DailyResetSchedulerService.CRON_NAME, job);
    job.start();

    this.logger.log(
      `Daily reset cron armed: '${policy.cronExpression}' (resetTo=${policy.resetTicketNumberTo}).`,
    );
  }
}