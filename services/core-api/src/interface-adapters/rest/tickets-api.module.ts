import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
} from '../../domain/queue';
import { TRANSACTION_MANAGER } from '../../domain/shared';
import { CreateTicketUseCase } from '../../application/queue';
import { QueueEventDispatcher } from '../../application/queue/queue-event-dispatcher';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { RealtimeModule } from '../websocket/realtime.module';
import { TicketsController } from './tickets.controller';

/**
 * Wires the kiosk ticket-creation surface (QUE-9). The use case is a pure,
 * framework-free class (no `@Injectable`/`@Inject` — it stays decoupled from
 * Nest, consistent with the existing application layer), so it is provided here
 * via a factory that receives the repository ports from {@link PersistenceModule},
 * the {@link QueueEventDispatcher} from {@link RealtimeModule} (the seam
 * {@link RealtimeModule} exports precisely so QUE-9+ use-case modules can
 * broadcast domain events without depending on the WebSocket transport), and
 * the {@link ITransactionManager} port (QUE-30) so reserve+save commits
 * atomically under the PostgreSQL profile.
 *
 * Kept separate from {@link RestApiModule}, which is the *read-only* caller
 * workspace surface (QUE-19) — ticket creation is a kiosk mutation, not a
 * caller read, so it gets its own module to preserve that boundary (SRP).
 */
@Module({
  imports: [PersistenceModule.forRoot(), RealtimeModule],
  controllers: [TicketsController],
  providers: [
    {
      provide: CreateTicketUseCase,
      inject: [
        QUEUE_REPOSITORY,
        CATEGORY_REPOSITORY,
        SEQUENCE_REPOSITORY,
        QueueEventDispatcher,
        TRANSACTION_MANAGER,
      ],
      useFactory: (queue, categories, sequences, dispatcher, txManager) =>
        new CreateTicketUseCase(queue, categories, sequences, dispatcher, undefined, txManager),
    },
  ],
})
export class TicketsApiModule {}