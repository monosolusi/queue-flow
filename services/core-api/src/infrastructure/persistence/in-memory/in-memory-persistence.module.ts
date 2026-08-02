import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
  TICKET_ARCHIVE_PORT,
} from '../../../domain/queue';
import {
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../../domain/store-config';
import { AUDIT_LOG_REPOSITORY } from '../../../domain/audit';
import { REPORT_QUERY_PORT } from '../../../domain/reporting';
import { TRANSACTION_MANAGER, NoOpTransactionManager } from '../../../domain/shared';
import {
  InMemoryAuditLogRepository,
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
  InMemoryReportQueryRepository,
  InMemorySequenceRepository,
  InMemorySystemConfigurationRepository,
} from '.';
import { DevSeedService } from '../seed/dev-seed.service';

/**
 * In-memory persistence profile (QUE-30). A **static** `@Module` so NestJS
 * deduplicates it across every importer of {@link PersistenceModule} — all
 * consumers share one `InMemory*Repository` instance (the tests seed config via
 * `app.get(SYSTEM_CONFIGURATION_REPOSITORY)` and the validator reads the same
 * instance). A freshly-returned DynamicModule would NOT be deduped, producing
 * one repo instance per importer and breaking the shared-singleton assumption.
 *
 * Includes the no-op {@link NoOpTransactionManager} and the dev-only
 * {@link DevSeedService} (seeds sample data only when `QMS_DEV_SEED=1`).
 */
@Module({
  providers: [
    { provide: QUEUE_REPOSITORY, useClass: InMemoryQueueRepository },
    // The in-memory queue repo also implements ITicketArchivePort (QUE-16).
    // Alias the same instance under the archive port token so the daily-reset
    // use case depends on the small archive port (ISP), not the full repo.
    { provide: TICKET_ARCHIVE_PORT, useExisting: QUEUE_REPOSITORY },
    { provide: COUNTER_ROUTING_RULE_REPOSITORY, useClass: InMemoryCounterRoutingRuleRepository },
    { provide: CATEGORY_REPOSITORY, useClass: InMemoryCategoryRepository },
    { provide: SEQUENCE_REPOSITORY, useClass: InMemorySequenceRepository },
    {
      provide: SYSTEM_CONFIGURATION_REPOSITORY,
      useClass: InMemorySystemConfigurationRepository,
    },
    { provide: AUDIT_LOG_REPOSITORY, useClass: InMemoryAuditLogRepository },
    // QUE-26 reporting read side. The in-memory report query scans the SAME
    // queue store the live queue uses (active tickets via allActive() + archived
    // via archivedTickets()), so it must share the QUEUE_REPOSITORY singleton —
    // wire it through a factory injecting that token (+ CATEGORY_REPOSITORY for
    // code mapping). The report repo depends on the concrete InMemoryQueueRepo
    // for its reporting-only read accessors (infrastructure → infrastructure;
    // the write-side port stays free of list-all methods), so the token-bound
    // IQueueRepository is narrowed to the concrete class here (dev/test only).
    {
      provide: REPORT_QUERY_PORT,
      inject: [QUEUE_REPOSITORY, CATEGORY_REPOSITORY],
      useFactory: (queue, categories) =>
        new InMemoryReportQueryRepository(queue as InMemoryQueueRepository, categories),
    },
    { provide: TRANSACTION_MANAGER, useClass: NoOpTransactionManager },
    DevSeedService,
  ],
  exports: [
    QUEUE_REPOSITORY,
    TICKET_ARCHIVE_PORT,
    COUNTER_ROUTING_RULE_REPOSITORY,
    CATEGORY_REPOSITORY,
    SEQUENCE_REPOSITORY,
    SYSTEM_CONFIGURATION_REPOSITORY,
    AUDIT_LOG_REPOSITORY,
    REPORT_QUERY_PORT,
    TRANSACTION_MANAGER,
  ],
})
export class InMemoryPersistenceModule {}