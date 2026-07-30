import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
} from '../../domain/queue';
import { COUNTER_ROUTING_RULE_REPOSITORY } from '../../domain/store-config';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
  InMemoryQueueRepository,
  InMemorySequenceRepository,
} from './in-memory';
import { DevSeedService } from './seed/dev-seed.service';

/**
 * Binds the in-memory repository concretions to their domain port tokens (DIP):
 * the application layer depends on the tokens, this infrastructure module
 * supplies the implementations. Replaced by a PostgreSQL persistence module
 * once the database lands (QUE-9 persistence / QUE-28 durability). Exports the
 * tokens so use-case factories in {@link RestApiModule} / {@link TicketsApiModule}
 * can inject them.
 *
 * Includes the dev-only {@link DevSeedService}, which populates sample counters
 * and tickets for the local runtime only when `QMS_DEV_SEED=1` is set.
 */
@Module({
  providers: [
    { provide: QUEUE_REPOSITORY, useClass: InMemoryQueueRepository },
    { provide: COUNTER_ROUTING_RULE_REPOSITORY, useClass: InMemoryCounterRoutingRuleRepository },
    { provide: CATEGORY_REPOSITORY, useClass: InMemoryCategoryRepository },
    { provide: SEQUENCE_REPOSITORY, useClass: InMemorySequenceRepository },
    DevSeedService,
  ],
  exports: [
    QUEUE_REPOSITORY,
    COUNTER_ROUTING_RULE_REPOSITORY,
    CATEGORY_REPOSITORY,
    SEQUENCE_REPOSITORY,
  ],
})
export class PersistenceModule {}