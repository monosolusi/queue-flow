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
import { TRANSACTION_MANAGER } from '../../../domain/shared';
import { PG_CONNECTION, createPgPool } from './postgres-connection.provider';
import { PostgresQueueRepository } from './postgres-queue.repository';
import { PostgresSequenceRepository } from './postgres-sequence.repository';
import { PostgresCategoryRepository } from './postgres-category.repository';
import { PostgresCounterRoutingRuleRepository } from './postgres-counter-routing-rule.repository';
import { PostgresSystemConfigurationRepository } from './postgres-system-configuration.repository';
import { PostgresAuditLogRepository } from './postgres-audit-log.repository';
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
    // Each Postgres repo is a plain class whose constructor takes the shared
    // `pg.Pool`. `useClass` would have NestJS resolve that param by the `Pool`
    // *class* token — which is not bound (the pool is bound to the PG_CONNECTION
    // Symbol below). Wire each repo through a factory injecting the Symbol so
    // DI resolution succeeds (LSP: the Postgres concretions are actually
    // substitutable for the in-memory ones at runtime). Same pattern the
    // transaction manager already uses.
    {
      provide: QUEUE_REPOSITORY,
      useFactory: (pool) => new PostgresQueueRepository(pool),
      inject: [PG_CONNECTION],
    },
    // The Postgres queue repo also implements ITicketArchivePort (QUE-16).
    // Alias the same instance under the archive port token so the daily-reset
    // use case depends on the small archive port (ISP), not the full repo.
    { provide: TICKET_ARCHIVE_PORT, useExisting: QUEUE_REPOSITORY },
    {
      provide: SEQUENCE_REPOSITORY,
      useFactory: (pool) => new PostgresSequenceRepository(pool),
      inject: [PG_CONNECTION],
    },
    {
      provide: CATEGORY_REPOSITORY,
      useFactory: (pool) => new PostgresCategoryRepository(pool),
      inject: [PG_CONNECTION],
    },
    {
      provide: COUNTER_ROUTING_RULE_REPOSITORY,
      useFactory: (pool) => new PostgresCounterRoutingRuleRepository(pool),
      inject: [PG_CONNECTION],
    },
    {
      provide: SYSTEM_CONFIGURATION_REPOSITORY,
      useFactory: (pool) => new PostgresSystemConfigurationRepository(pool),
      inject: [PG_CONNECTION],
    },
    {
      provide: AUDIT_LOG_REPOSITORY,
      useFactory: (pool) => new PostgresAuditLogRepository(pool),
      inject: [PG_CONNECTION],
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
    TICKET_ARCHIVE_PORT,
    SEQUENCE_REPOSITORY,
    CATEGORY_REPOSITORY,
    COUNTER_ROUTING_RULE_REPOSITORY,
    SYSTEM_CONFIGURATION_REPOSITORY,
    AUDIT_LOG_REPOSITORY,
    TRANSACTION_MANAGER,
  ],
})
export class PostgresPersistenceModule {}