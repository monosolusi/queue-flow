import { Module } from '@nestjs/common';
import {
  CATEGORY_REPOSITORY,
  QUEUE_REPOSITORY,
  SEQUENCE_REPOSITORY,
} from '../../domain/queue';
import { CreateTicketUseCase } from '../../application/queue';
import { QueueEventDispatcher } from '../../application/queue/queue-event-dispatcher';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { RealtimeModule } from '../websocket/realtime.module';
import { TicketsController } from './tickets.controller';

/**
 * Wires the kiosk ticket-creation surface (QUE-9). The use case is a pure,
 * framework-free class (no `@Injectable`/`@Inject` — it stays decoupled from
 * Nest, consistent with the existing application layer), so it is provided here
 * via a factory that receives the repository ports from {@link PersistenceModule}
 * and the {@link QueueEventDispatcher} from {@link RealtimeModule} (the seam
 * {@link RealtimeModule} exports precisely so QUE-9+ use-case modules can
 * broadcast domain events without depending on the WebSocket transport).
 *
 * Kept separate from {@link RestApiModule}, which is the *read-only* caller
 * workspace surface (QUE-19) — ticket creation is a kiosk mutation, not a
 * caller read, so it gets its own module to preserve that boundary (SRP).
 */
@Module({
  imports: [PersistenceModule, RealtimeModule],
  controllers: [TicketsController],
  providers: [
    {
      provide: CreateTicketUseCase,
      inject: [QUEUE_REPOSITORY, CATEGORY_REPOSITORY, SEQUENCE_REPOSITORY, QueueEventDispatcher],
      useFactory: (queue, categories, sequences, dispatcher) =>
        new CreateTicketUseCase(queue, categories, sequences, dispatcher),
    },
  ],
})
export class TicketsApiModule {}