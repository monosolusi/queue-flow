import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ResetDailyQueueUseCase } from '../../application/queue';
import {
  DailyResetMode,
  type IDailyResetSchedulerPort,
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../domain/store-config';

/**
 * Drives the *automatic* daily reset (FR-ENG-05 / QUE-2). Reads the active
 * {@link DailyResetPolicy} from the singleton `SystemConfiguration` and, when
 * the mode is `AUTOMATIC_CRON`, arms a cron job that invokes
 * {@link ResetDailyQueueUseCase} with the policy's `resetTicketNumberTo`. The
 * use case rolls the per-category sequence back and emits the `SYSTEM_RESET`
 * event. `MANUAL` mode arms nothing — resets then flow through the
 * `POST /api/system/daily-reset` endpoint.
 *
 * The `cron` library runs expressions in the host's local time, which matches the
 * single on-premise box / local-LAN deployment (NFR-SEC-01) and the local-time
 * `toDateKey` convention the sequence key uses.
 *
 * Re-arming (QUE-32 / FR-ADM-01): the cron is armed at boot via `onModuleInit`
 * AND re-armed whenever a manager saves a config that changes the
 * `DailyResetPolicy` — the save use case calls {@link reArm} post-commit through
 * the {@link IDailyResetSchedulerPort} so a policy edit takes effect
 * **immediately, without a process restart** (mirroring the per-execution
 * `ITransitionPolicyResolver` precedent). `reArm` reconciles idempotently: it
 * disarms when the policy is `MANUAL` / unconfigured, arms (or re-arms) when it
 * is `AUTOMATIC_CRON` with a valid expression, and is a no-op when the desired
 * cron already matches the armed one (so a categories-only edit does not churn
 * the running cron).
 *
 * Lives in infrastructure: it owns the cron I/O (a framework/timer concern), so
 * it must not live in domain or application. dep-cruiser permits infrastructure
 * → application/domain.
 */
@Injectable()
export class DailyResetSchedulerService implements OnModuleInit, IDailyResetSchedulerPort {
  private readonly logger = new Logger(DailyResetSchedulerService.name);
  private static readonly CRON_NAME = 'daily-reset';
  /** The cron expression currently armed, or `null` when disarmed. Tracks the
   * running state so {@link reArm} can skip a no-op stop/start when the policy
   * is unchanged. Also the integration-test seam for observing the armed cron. */
  private armedCron: string | null = null;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly resetDailyQueue: ResetDailyQueueUseCase,
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly config: ISystemConfigurationRepository,
  ) {}

  /** Read-only observability seam: the cron expression currently armed (or null). */
  public get armedCronExpression(): string | null {
    return this.armedCron;
  }

  async onModuleInit(): Promise<void> {
    await this.reArm();
  }

  public async reArm(): Promise<void> {
    const system = await this.config.get();
    const policy = system?.dailyResetPolicy ?? null;
    const desiredCron =
      policy &&
      policy.mode === DailyResetMode.AUTOMATIC_CRON &&
      policy.cronExpression
        ? policy.cronExpression
        : null;

    // Idempotent: nothing to do when the desired cron already matches the armed
    // one (both null = disarmed; both equal = same expression).
    if (desiredCron === this.armedCron) {
      return;
    }

    // Disarm-only path (MANUAL mode or unconfigured): no new job to construct,
    // so deleting the existing one is safe and final.
    if (desiredCron === null) {
      if (this.registry.doesExist('cron', DailyResetSchedulerService.CRON_NAME)) {
        this.registry.deleteCronJob(DailyResetSchedulerService.CRON_NAME);
      }
      this.armedCron = null;
      this.logger.log(
        system
          ? `Daily reset mode is '${policy!.mode}' — cron disarmed (use POST /api/system/daily-reset).`
          : 'System not configured yet — daily reset scheduler idle.',
      );
      return;
    }

    // Construct the new CronJob BEFORE deleting the old one (NFR-REL-02). The
    // `cron` library parses + validates the expression in the constructor, so
    // this is where a bad expression would throw — by constructing first, a
    // throw leaves the previously-armed cron intact (the DB-side save already
    // committed, so losing the running cron here would leave the store with no
    // automatic daily reset until a restart). The VO's `isValidCronExpression`
    // guard makes this throw near-impossible in practice, but this keeps
    // `reArm` self-safe regardless. `addCronJob`/`start` only run after the
    // constructor succeeds.
    const job = new CronJob(desiredCron, () => {
      void this.resetDailyQueue.execute({
        resetTo: policy!.resetTicketNumberTo,
        // `archivePreviousDay` translates `DailyResetPolicy.archivePreviousDayData`
        // (FR-WZD-05 / QUE-16). No `actor` → the automatic path is not audited
        // (NFR-SEC-02), matching the manual-reset scoping.
        archivePreviousDay: policy!.archivePreviousDayData,
      });
    });

    // Now safe to disarm the old job and register the new one.
    if (this.registry.doesExist('cron', DailyResetSchedulerService.CRON_NAME)) {
      this.registry.deleteCronJob(DailyResetSchedulerService.CRON_NAME);
    }
    this.registry.addCronJob(DailyResetSchedulerService.CRON_NAME, job);
    job.start();
    this.armedCron = desiredCron;

    this.logger.log(
      `Daily reset cron armed: '${desiredCron}' (resetTo=${policy!.resetTicketNumberTo}, archive=${policy!.archivePreviousDayData}).`,
    );
  }
}