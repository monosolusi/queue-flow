import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RealtimeModule } from './interface-adapters/websocket/realtime.module';
import { RestApiModule } from './interface-adapters/rest/rest-api.module';
import { TicketsApiModule } from './interface-adapters/rest/tickets-api.module';
import { QueueCommandsApiModule } from './interface-adapters/rest/queue-commands-api.module';
import { SystemApiModule } from './interface-adapters/rest/system-api.module';
import { SystemConfigApiModule } from './interface-adapters/rest/system-config-api.module';
import { ReportingApiModule } from './interface-adapters/rest/reporting-api.module';
import { HealthModule } from './interface-adapters/rest/health.module';
import { SchedulerModule } from './infrastructure/scheduler/scheduler.module';
import { BootstrapModule } from './infrastructure/bootstrap/bootstrap.module';

/**
 * Root module. The realtime broadcaster (QUE-12) is imported so the WebSocket
 * gateway and event-publishing seam are available app-wide; the read-only REST
 * surface for the caller workspace (QUE-19) and the kiosk ticket-creation
 * surface (QUE-9) are imported here too. QUE-2 adds the queue command REST
 * surface (call-next/serve/complete/skip/recall/transfer), the system-admin
 * daily-reset surface, and the automatic daily-reset scheduler. QUE-30 adds the
 * health probe, the system-config / wizard REST surface
 * (`GET|PUT /api/system/config`, `GET /api/system/state-machine`), and wires
 * persistence via `PersistenceModule.forRoot()` inside each feature module
 * (env-driven in-memory ↔ PostgreSQL). QUE-13 adds the gateway first-run guard
 * probe (`GET /api/system/setup-status`) and the eager `BootstrapModule`
 * checker that re-reads + logs the persisted setup status at boot. QUE-26 adds
 * the analytics + audit-trail read surface (`GET /api/reports/daily`,
 * `GET /api/reports/counters/:id`, `GET /api/audit/log`) for the admin dashboard.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    RealtimeModule,
    RestApiModule,
    TicketsApiModule,
    QueueCommandsApiModule,
    SystemApiModule,
    SystemConfigApiModule,
    ReportingApiModule,
    HealthModule,
    SchedulerModule,
    BootstrapModule,
  ],
})
export class AppModule {}