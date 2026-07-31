import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CATEGORY_REPOSITORY } from '../../domain/queue';
import { COUNTER_ROUTING_RULE_REPOSITORY } from '../../domain/store-config';
import { QUEUE_REPOSITORY } from '../../domain/queue';
import {
  GetQueueSnapshotUseCase,
  ListCategoriesUseCase,
  ListCountersUseCase,
} from '../../application';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { CategoriesController } from './categories.controller';
import { CountersController } from './counters.controller';
import { QueueController } from './queue.controller';
import { DomainExceptionFilter } from './domain-exception.filter';

/**
 * Wires the read-only REST surface for the caller and kiosk workspaces
 * (QUE-19 + QUE-17). The use cases are pure, framework-free classes (no
 * `@Injectable`/`@Inject` — they stay decoupled from Nest, consistent with the
 * existing application layer), so they are provided here via factories that
 * receive the repository ports injected from {@link PersistenceModule}.
 * Controllers depend on the use-case class tokens, which Nest resolves because
 * each is `provide`d as itself.
 */
@Module({
  imports: [PersistenceModule.forRoot()],
  controllers: [CountersController, QueueController, CategoriesController],
  providers: [
    // Global HTTP filter mapping domain errors to HTTP statuses so the
    // application layer stays free of HTTP concerns (NFR-MNT-01). Registered as
    // APP_FILTER so it applies in production and in integration tests that boot
    // the app directly (no need to call useGlobalFilters in tests).
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: ListCountersUseCase,
      inject: [COUNTER_ROUTING_RULE_REPOSITORY, CATEGORY_REPOSITORY],
      useFactory: (routingRules, categories) =>
        new ListCountersUseCase(routingRules, categories),
    },
    {
      provide: GetQueueSnapshotUseCase,
      inject: [QUEUE_REPOSITORY, COUNTER_ROUTING_RULE_REPOSITORY],
      useFactory: (queue, routingRules) =>
        new GetQueueSnapshotUseCase(queue, routingRules),
    },
    {
      provide: ListCategoriesUseCase,
      inject: [CATEGORY_REPOSITORY],
      useFactory: (categories) => new ListCategoriesUseCase(categories),
    },
  ],
})
export class RestApiModule {}