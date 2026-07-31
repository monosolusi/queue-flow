import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * Standalone health-probe module (QUE-30). Imported by {@link AppModule} so the
 * liveness endpoint is available app-wide with no persistence/realtime coupling
 * — it answers even before the wizard has configured the system.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}