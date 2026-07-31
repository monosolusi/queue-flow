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
import { TRANSACTION_MANAGER } from '../../../domain/shared';
import { PG_CONNECTION, createPgPool } from './postgres-connection.provider';
import { PostgresQueueRepository } from './postgres-queue.repository';
import { PostgresSequenceRepository } from './postgres-sequence.repository';
import { PostgresCategoryRepository } from './postgres-category.repository';
import { PostgresCounterRoutingRuleRepository } from './postgres-counter-routing-rule.repository';
import { PostgresSystemConfigurationRepository } from './postgres-system-configuration.repository';
import { PostgresTransactionManager } from './postgres-transaction-manager';
import { PostgresMigrationRunner } from './migration-runner';

/**
 * PostgreSQL profile of persistence (QUE-30). Binds the domain repository ports
 * to their PostgreSQL concretions (DIP: the application layer depends on the
 * tokens, this module supplies the impls), provides the shared `pg.Pool` and the
 * {@link PostgresTransactionManager} for atomic reserve+save (NFR-REL-02), and
 * runs the idempotent schema migrations at boot. Activated by
 * {@link PersistenceModule.forRoot} when `QMS_PERSISTENCE=postgres`.
 *
 * The audit-log repository token is bound separately (the audit context lands
 * in phase 2); this module imports the audit persistence module once it exists.
 */
@Module({
  providers: [
    { provide: PG_CONNECTION, useFactory: createPgPool },
    { provide: QUEUE_REPOSITORY, useClass: PostgresQueueRepository },
    { provide: SEQUENCE_REPOSITORY, useClass: PostgresSequenceRepository },
    { provide: CATEGORY_REPOSITORY, useClass: PostgresCategoryRepository },
    { provide: COUNTER_ROUTING_RULE_REPOSITORY, useClass: PostgresCounterRoutingRuleRepository },
    {
      provide: SYSTEM_CONFIGURATION_REPOSITORY,
      useClass: PostgresSystemConfigurationRepository,
    },
    {
      provide: TRANSACTION_MANAGER,
      useFactory: (pool) => new PostgresTransactionManager(pool),
      inject: [PG_CONNECTION],
    },
    PostgresMigrationRunner,
  ],
  exports: [
    QUEUE_REPOSITORY,
    SEQUENCE_REPOSITORY,
    CATEGORY_REPOSITORY,
    COUNTER_ROUTING_RULE_REPOSITORY,
    SYSTEM_CONFIGURATION_REPOSITORY,
    TRANSACTION_MANAGER,
  ],
})
export class PostgresPersistenceModule {}