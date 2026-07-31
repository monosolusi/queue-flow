import { Module } from '@nestjs/common';
import { QueueOperationsModule } from '../queue-operations.module';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { SystemAdminController } from './system-admin.controller';

/**
 * Wires the system-admin REST surface (QUE-2). {@link QueueOperationsModule}
 * supplies the {@link ResetDailyQueueUseCase} token; {@link PersistenceModule}
 * supplies the {@link SYSTEM_CONFIGURATION_REPOSITORY} token the controller reads
 * the active `DailyResetPolicy` from. Kept separate from the queue command and
 * read-only modules per the per-concern module split (SRP): system-admin
 * operations are a distinct concern.
 */
@Module({
  imports: [QueueOperationsModule, PersistenceModule.forRoot()],
  controllers: [SystemAdminController],
})
export class SystemApiModule {}