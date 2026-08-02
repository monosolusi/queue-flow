import { Module } from '@nestjs/common';
import { CATEGORY_REPOSITORY } from '../../domain/queue';
import {
  COUNTER_ROUTING_RULE_REPOSITORY,
  DAILY_RESET_SCHEDULER,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../domain/store-config';
import { AUDIT_LOG_REPOSITORY } from '../../domain/audit';
import { TRANSACTION_MANAGER } from '../../domain/shared';
import {
  GetActiveStateMachineUseCase,
  GetSetupStatusUseCase,
  GetSystemConfigurationUseCase,
  SaveSystemConfigurationUseCase,
} from '../../application/store-config';
import { RecordAuditEntryUseCase } from '../../application/audit/record-audit-entry.use-case';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { SchedulerModule } from '../../infrastructure/scheduler/scheduler.module';
import { SystemConfigController } from './system-config.controller';

/**
 * Wires the system-config REST surface for the admin panel + first-run wizard
 * (QUE-30 / FR-WZD-01..06). Kept separate from the read-only {@link RestApiModule}
 * and the system-admin daily-reset {@link SystemApiModule} per the per-concern
 * module split (SRP): configuration CRUD is a distinct concern from queue reads
 * and queue control.
 *
 * The three use cases are pure, framework-free classes (no `@Injectable`/
 * `@Inject` — consistent with the application layer), so each is provided via a
 * factory receiving its domain ports from {@link PersistenceModule}. The save
 * use case additionally receives the {@link ITransactionManager} (atomic
 * full-replacement save, NFR-REL-02), a {@link RecordAuditEntryUseCase} built
 * on the {@link IAuditLogRepository} (NFR-SEC-02), and the
 * {@link IDailyResetSchedulerPort} (QUE-32) so a policy edit re-arms the cron
 * post-commit without a restart. The {@link SchedulerModule} exports that port;
 * importing it here creates no cycle (SchedulerModule → QueueOperationsModule →
 * SystemConfigModule-the-resolver, none of which import this module). The global
 * {@link DomainExceptionFilter} (registered in RestApiModule, applies app-wide)
 * maps the domain errors these use cases throw to HTTP.
 */
@Module({
  imports: [PersistenceModule.forRoot(), SchedulerModule],
  controllers: [SystemConfigController],
  providers: [
    {
      provide: GetSystemConfigurationUseCase,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY, CATEGORY_REPOSITORY, COUNTER_ROUTING_RULE_REPOSITORY],
      useFactory: (config, categories, routingRules) =>
        new GetSystemConfigurationUseCase(config, categories, routingRules),
    },
    {
      provide: GetActiveStateMachineUseCase,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY],
      useFactory: (config) => new GetActiveStateMachineUseCase(config),
    },
    {
      provide: GetSetupStatusUseCase,
      inject: [SYSTEM_CONFIGURATION_REPOSITORY],
      useFactory: (config) => new GetSetupStatusUseCase(config),
    },
    {
      provide: SaveSystemConfigurationUseCase,
      inject: [
        SYSTEM_CONFIGURATION_REPOSITORY,
        CATEGORY_REPOSITORY,
        COUNTER_ROUTING_RULE_REPOSITORY,
        TRANSACTION_MANAGER,
        AUDIT_LOG_REPOSITORY,
        DAILY_RESET_SCHEDULER,
      ],
      useFactory: (config, categories, routingRules, txManager, auditLog, scheduler) =>
        new SaveSystemConfigurationUseCase(
          config,
          categories,
          routingRules,
          txManager,
          new RecordAuditEntryUseCase(auditLog),
          scheduler,
        ),
    },
  ],
})
export class SystemConfigApiModule {}