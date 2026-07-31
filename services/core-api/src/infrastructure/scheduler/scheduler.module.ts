import { Module } from '@nestjs/common';
import { QueueOperationsModule } from '../../interface-adapters/queue-operations.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { DailyResetSchedulerService } from './daily-reset-scheduler.service';

/**
 * Wires the automatic daily-reset scheduler (QUE-2). {@link QueueOperationsModule}
 * supplies the {@link ResetDailyQueueUseCase} token the scheduler triggers, and
 * {@link PersistenceModule} supplies the {@link SYSTEM_CONFIGURATION_REPOSITORY}
 * token it reads the active `DailyResetPolicy` from. The
 * {@link DailyResetSchedulerService} arms its cron job in `onModuleInit`.
 *
 * {@link ScheduleModule} (from `@nestjs/schedule`) is registered `forRoot` in
 * {@link AppModule} so the `SchedulerRegistry` is available app-wide.
 */
@Module({
  imports: [PersistenceModule, QueueOperationsModule],
  providers: [DailyResetSchedulerService],
})
export class SchedulerModule {}