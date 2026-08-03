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
import { TRANSACTION_MANAGER } from '../../../domain/shared';
import { PG_CONNECTION, createPgPool } from './postgres-connection.provider';
import { PostgresQueueRepository } from './postgres-queue.repository';
import { PostgresSequenceRepository } from './postgres-sequence.repository';
import { PostgresCategoryRepository } from './postgres-category.repository';
import { PostgresCounterRoutingRuleRepository } from './postgres-counter-routing-rule.repository';
import { PostgresSystemConfigurationRepository } from './postgres-system-configuration.repository';
import { PostgresAuditLogRepository } from './postgres-audit-log.repository';
import { PostgresReportQueryRepository } from './postgres-report-query.repository';
import { PostgresTransactionManager } from './postgres-transaction-manager';
import { PostgresMigrationRunner } from './migration-runner';
import { PostgresDurabilityProbe } from './durability-probe';

/**
 * PostgreSQL profile of persistence (QUE-30 / QUE-28). Binds the domain
 * repository ports to their PostgreSQL concretions (DIP: the application layer
 * depends on the tokens, this module supplies the impls), provides the shared
 * `pg.Pool` (with `synchronous_commit=on` enforced per-connection via its
 * `onConnect` hook) and the {@link PostgresTransactionManager} for atomic
 * reserve+save (NFR-REL-02), runs the idempotent schema migrations at boot, and
 * verifies the durability contract (`fsync=on`) via {@link
 * PostgresDurabilityProbe} as the startup recovery flow. Activated by
 * {@link PersistenceModule.forRoot} when `QMS_PERSISTENCE=postgres`.
 *
 * The audit-log repository token is bound inline below (same `useFactory` +
 * `PG_CONNECTION` pattern as the other Postgres repos); the audit bounded
 * context owns the `IAuditLogRepository` port and `AuditLogEntry` aggregate in
 * `domain/audit` (anti-corruption — no separate audit persistence module).
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
    // QUE-26 reporting read side — raw-SQL CQRS read over tickets + archived_tickets.
    {
      provide: REPORT_QUERY_PORT,
      useFactory: (pool) => new PostgresReportQueryRepository(pool),
      inject: [PG_CONNECTION],
    },
    {
      provide: TRANSACTION_MANAGER,
      useFactory: (pool) => new PostgresTransactionManager(pool),
      inject: [PG_CONNECTION],
    },
    PostgresMigrationRunner,
    // Boot-time durability contract probe (QUE-28 / NFR-REL-02): verifies
    // `fsync=on` (a server-level GUC that the per-connection `onConnect` hook in
    // createPgPool cannot set) and fails fast if the server would not survive a
    // power cut. Schema-independent (needs only the pool), so no OnModuleInit
    // ordering constraint vs. PostgresMigrationRunner.
    PostgresDurabilityProbe,
  ],
  exports: [
    QUEUE_REPOSITORY,
    TICKET_ARCHIVE_PORT,
    SEQUENCE_REPOSITORY,
    CATEGORY_REPOSITORY,
    COUNTER_ROUTING_RULE_REPOSITORY,
    SYSTEM_CONFIGURATION_REPOSITORY,
    AUDIT_LOG_REPOSITORY,
    REPORT_QUERY_PORT,
    TRANSACTION_MANAGER,
  ],
})
export class PostgresPersistenceModule {}