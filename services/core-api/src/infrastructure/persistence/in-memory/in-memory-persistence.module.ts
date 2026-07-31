import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
} from '../../../domain/queue';
import {
  COUNTER_ROUTING_RULE_REPOSITORY,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../../domain/store-config';
import { TRANSACTION_MANAGER, NoOpTransactionManager } from '../../../domain/shared';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
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
    { provide: COUNTER_ROUTING_RULE_REPOSITORY, useClass: InMemoryCounterRoutingRuleRepository },
    { provide: CATEGORY_REPOSITORY, useClass: InMemoryCategoryRepository },
    { provide: SEQUENCE_REPOSITORY, useClass: InMemorySequenceRepository },
    {
      provide: SYSTEM_CONFIGURATION_REPOSITORY,
      useClass: InMemorySystemConfigurationRepository,
    },
    { provide: TRANSACTION_MANAGER, useClass: NoOpTransactionManager },
    DevSeedService,
  ],
  exports: [
    QUEUE_REPOSITORY,
    COUNTER_ROUTING_RULE_REPOSITORY,
    CATEGORY_REPOSITORY,
    SEQUENCE_REPOSITORY,
    SYSTEM_CONFIGURATION_REPOSITORY,
    TRANSACTION_MANAGER,
  ],
})
export class InMemoryPersistenceModule {}