import { Module } from '@nestjs/common';
import { QueueOperationsModule } from '../../interface-adapters/queue-operations.module';
import { DAILY_RESET_SCHEDULER } from '../../domain/store-config';
import { PersistenceModule } from '../persistence/persistence.module';
import { DailyResetSchedulerService } from './daily-reset-scheduler.service';

/**
 * Wires the automatic daily-reset scheduler (QUE-2 / QUE-32).
 * {@link QueueOperationsModule} supplies the {@link ResetDailyQueueUseCase} token
 * the scheduler triggers, and {@link PersistenceModule} supplies the
 * {@link SYSTEM_CONFIGURATION_REPOSITORY} token it reads the active
 * `DailyResetPolicy` from. The {@link DailyResetSchedulerService} arms its cron
 * job in `onModuleInit` and re-arms it on config change via the
 * {@link DAILY_RESET_SCHEDULER} port (QUE-32) — exported so the
 * `SystemConfigApiModule` (which provides the save use case) can inject it.
 *
 * {@link ScheduleModule} (from `@nestjs/schedule`) is registered `forRoot` in
 * {@link AppModule} so the `SchedulerRegistry` is available app-wide.
 */
@Module({
  imports: [PersistenceModule.forRoot(), QueueOperationsModule],
  providers: [
    DailyResetSchedulerService,
    { provide: DAILY_RESET_SCHEDULER, useExisting: DailyResetSchedulerService },
  ],
  exports: [DAILY_RESET_SCHEDULER],
})
export class SchedulerModule {}