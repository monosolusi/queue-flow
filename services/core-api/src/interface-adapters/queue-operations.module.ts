import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
  TRANSITION_POLICY_RESOLVER,
} from '../domain/queue';
import { COUNTER_ROUTING_RULE_REPOSITORY } from '../domain/store-config';
import { TRANSACTION_MANAGER } from '../domain/shared';
import {
  CallNextTicketUseCase,
  CompleteTicketUseCase,
  RecallTicketUseCase,
  ResetDailyQueueUseCase,
  ServeTicketUseCase,
  SkipTicketUseCase,
  TransferTicketUseCase,
} from '../application/queue';
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
      provide: ServeTicketUseCase,
      inject: [QUEUE_REPOSITORY, TRANSITION_POLICY_RESOLVER, QueueEventDispatcher],
      useFactory: (queue, policyResolver, dispatcher) =>
        new ServeTicketUseCase(queue, policyResolver, dispatcher),
    },
    {
      provide: CompleteTicketUseCase,
      inject: [QUEUE_REPOSITORY, TRANSITION_POLICY_RESOLVER, QueueEventDispatcher],
      useFactory: (queue, policyResolver, dispatcher) =>
        new CompleteTicketUseCase(queue, policyResolver, dispatcher),
    },
    {
      provide: SkipTicketUseCase,
      inject: [QUEUE_REPOSITORY, TRANSITION_POLICY_RESOLVER, QueueEventDispatcher],
      useFactory: (queue, policyResolver, dispatcher) =>
        new SkipTicketUseCase(queue, policyResolver, dispatcher),
    },
    {
      provide: RecallTicketUseCase,
      inject: [QUEUE_REPOSITORY, TRANSITION_POLICY_RESOLVER, QueueEventDispatcher],
      useFactory: (queue, policyResolver, dispatcher) =>
        new RecallTicketUseCase(queue, policyResolver, dispatcher),
    },
    {
      provide: TransferTicketUseCase,
      inject: [
        QUEUE_REPOSITORY,
        CATEGORY_REPOSITORY,
        SEQUENCE_REPOSITORY,
        TRANSITION_POLICY_RESOLVER,
        QueueEventDispatcher,
      ],
      useFactory: (queue, categories, sequences, policyResolver, dispatcher) =>
        new TransferTicketUseCase(queue, categories, sequences, policyResolver, dispatcher),
    },
    {
      provide: ResetDailyQueueUseCase,
      inject: [SEQUENCE_REPOSITORY, QueueEventDispatcher],
      useFactory: (sequences, dispatcher) =>
        new ResetDailyQueueUseCase(sequences, dispatcher),
    },
  ],
  exports: [
    CallNextTicketUseCase,
    ServeTicketUseCase,
    CompleteTicketUseCase,
    SkipTicketUseCase,
    RecallTicketUseCase,
    TransferTicketUseCase,
    ResetDailyQueueUseCase,
  ],
})
export class QueueOperationsModule {}