import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RealtimeModule } from './interface-adapters/websocket/realtime.module';
import { RestApiModule } from './interface-adapters/rest/rest-api.module';
import { TicketsApiModule } from './interface-adapters/rest/tickets-api.module';
import { QueueCommandsApiModule } from './interface-adapters/rest/queue-commands-api.module';
import { SystemApiModule } from './interface-adapters/rest/system-api.module';
import { HealthModule } from './interface-adapters/rest/health.module';
import { SchedulerModule } from './infrastructure/scheduler/scheduler.module';

/**
 * Root module. The realtime broadcaster (QUE-12) is imported so the WebSocket
 * gateway and event-publishing seam are available app-wide; the read-only REST
 * surface for the caller workspace (QUE-19) and the kiosk ticket-creation
 * surface (QUE-9) are imported here too. QUE-2 adds the queue command REST
 * surface (call-next/serve/complete/skip/recall/transfer), the system-admin
 * daily-reset surface, and the automatic daily-reset scheduler. QUE-30 adds the
 * health probe and wires persistence via `PersistenceModule.forRoot()` inside
 * each feature module (env-driven in-memory ↔ PostgreSQL).
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    RealtimeModule,
    RestApiModule,
    TicketsApiModule,
    QueueCommandsApiModule,
    SystemApiModule,
    HealthModule,
    SchedulerModule,
  ],
})
export class AppModule {}