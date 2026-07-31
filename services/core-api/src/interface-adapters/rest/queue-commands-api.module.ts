import { Module } from '@nestjs/common';
import { QueueOperationsModule } from '../queue-operations.module';
import { QueueCommandsController } from './queue-commands.controller';

/**
 * Wires the queue command REST surface (QUE-2). The use cases are provided by
 * {@link QueueOperationsModule} (the shared framework-free use-case wiring), so
 * this module only declares the controller — it owns no factories, keeping the
 * wiring DRY. Kept separate from the read-only {@link RestApiModule} per the
 * per-concern module split (SRP): caller command mutations are a distinct
 * concern from the read-only caller/kiosk surface.
 *
 * The global {@link DomainExceptionFilter} (registered as `APP_FILTER` in
 * {@link RestApiModule}, which `AppModule` imports) maps domain errors on these
 * routes — illegal transitions to 409, unknown tickets/categories to 404.
 */
@Module({
  imports: [QueueOperationsModule],
  controllers: [QueueCommandsController],
})
export class QueueCommandsApiModule {}