import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
  TICKET_ARCHIVE_PORT,
  TRANSITION_POLICY_RESOLVER,
} from '../domain/queue';
import { COUNTER_ROUTING_RULE_REPOSITORY } from '../domain/store-config';
import { AUDIT_LOG_REPOSITORY } from '../domain/audit';
import { TRANSACTION_MANAGER } from '../domain/shared';
import {
  ApplyTransitionUseCase,
  CallNextTicketUseCase,
  CleanupTransactionLogUseCase,
  ReannounceTicketUseCase,
  ResetDailyQueueUseCase,
  TransferTicketUseCase,
} from '../application/queue';
import { RecordAuditEntryUseCase } from '../application/audit/record-audit-entry.use-case';
import { QueueEventDispatcher } from '../application/queue/queue-event-dispatcher';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { RealtimeModule } from './websocket/realtime.module';
import { SystemConfigModule } from './config/system-config.module';

/**
 * Wires the framework-free queue use cases (QUE-2). The use cases are pure
 * classes (no `@Injectable`/`@Inject` — they stay decoupled from Nest,
 * consistent with the application layer), so each is provided via a factory
 * receiving its domain ports: the repository tokens from {@link PersistenceModule},
 * the {@link QueueEventDispatcher} from {@link RealtimeModule} (the seam
 * RealtimeModule exports precisely so use-case modules can broadcast domain
 * events without depending on the WebSocket transport), and the active-policy
 * resolver from {@link SystemConfigModule}.
 *
 * Centralizing the factories here keeps the wiring DRY: the REST command module
 * ({@link QueueCommandsApiModule}), the system/admin module ({@link SystemApiModule}),
 * and the daily-reset scheduler ({@link SchedulerModule}) all consume these
 * use-case tokens without re-declaring factories. Each `clock` parameter keeps
 * its `() => Date.now` default — factories omit it so production reads real time
 * while unit tests construct the use cases directly with a deterministic clock.
 */
@Module({
  imports: [PersistenceModule.forRoot(), RealtimeModule, SystemConfigModule],
  providers: [
    {
      provide: CallNextTicketUseCase,
      inject: [
        COUNTER_ROUTING_RULE_REPOSITORY,
        QUEUE_REPOSITORY,
        TRANSITION_POLICY_RESOLVER,
        QueueEventDispatcher,
        TRANSACTION_MANAGER,
      ],
      useFactory: (routingRules, queue, policyResolver, dispatcher, txManager) =>
        new CallNextTicketUseCase(routingRules, queue, policyResolver, dispatcher, undefined, txManager),
    },
    {
      // "Panggil Lagi" — re-announce the currently-calling ticket. No state
      // transition (no policy resolver) and no sequence reservation (no tx
      // manager) — just the queue repo + the dispatcher to drain the
      // re-emitted TICKET_CALLED (FR-ENG-04 / FR-TV-01/02).
      provide: ReannounceTicketUseCase,
      inject: [QUEUE_REPOSITORY, QueueEventDispatcher],
      useFactory: (queue, dispatcher) => new ReannounceTicketUseCase(queue, dispatcher),
    },
    {
      // The single per-ticket state-change command (FR-CLR-02). No tx manager —
      // a status change reserves no sequence number, so there is nothing to
      // commit atomically alongside it (unlike the transfer below).
      provide: ApplyTransitionUseCase,
      inject: [QUEUE_REPOSITORY, TRANSITION_POLICY_RESOLVER, QueueEventDispatcher],
      useFactory: (queue, policyResolver, dispatcher) =>
        new ApplyTransitionUseCase(queue, policyResolver, dispatcher),
    },
    {
      provide: TransferTicketUseCase,
      inject: [
        QUEUE_REPOSITORY,
        CATEGORY_REPOSITORY,
        SEQUENCE_REPOSITORY,
        TRANSITION_POLICY_RESOLVER,
        QueueEventDispatcher,
        TRANSACTION_MANAGER,
      ],
      useFactory: (queue, categories, sequences, policyResolver, dispatcher, txManager) =>
        new TransferTicketUseCase(
          queue,
          categories,
          sequences,
          policyResolver,
          dispatcher,
          undefined, // clock — keep the () => Date.now default
          txManager,
        ),
    },
    {
      provide: ResetDailyQueueUseCase,
      inject: [
        SEQUENCE_REPOSITORY,
        QueueEventDispatcher,
        AUDIT_LOG_REPOSITORY,
        TRANSACTION_MANAGER,
        TICKET_ARCHIVE_PORT,
      ],
      useFactory: (sequences, dispatcher, auditLog, txManager, ticketArchive) =>
        new ResetDailyQueueUseCase(
          sequences,
          dispatcher,
          undefined, // clock — keep the () => Date.now default
          new RecordAuditEntryUseCase(auditLog),
          txManager,
          ticketArchive,
        ),
    },
    {
      // QUE-25 / FR-ADM-02: transaction-log cleanup override. The use case is a
      // pure framework-free class provided via a factory receiving its ports:
      // the ticket-archive port (purge), the audit-log repo (composed into a
      // RecordAuditEntryUseCase for the TRANSACTION_LOG_CLEANUP audit record),
      // and the ambient transaction manager (atomic purge + audit, NFR-REL-02).
      // `clock` keeps its () => Date.now default.
      provide: CleanupTransactionLogUseCase,
      inject: [TICKET_ARCHIVE_PORT, AUDIT_LOG_REPOSITORY, TRANSACTION_MANAGER],
      useFactory: (ticketArchive, auditLog, txManager) =>
        new CleanupTransactionLogUseCase(
          ticketArchive,
          undefined, // clock — keep the () => Date.now default
          new RecordAuditEntryUseCase(auditLog),
          txManager,
        ),
    },
  ],
  exports: [
    CallNextTicketUseCase,
    ReannounceTicketUseCase,
    TransferTicketUseCase,
    ApplyTransitionUseCase,
    ResetDailyQueueUseCase,
    CleanupTransactionLogUseCase,
  ],
})
export class QueueOperationsModule {}