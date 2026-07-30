import { Module } from '@nestjs/common';
import { RealtimeModule } from './interface-adapters/websocket/realtime.module';
import { RestApiModule } from './interface-adapters/rest/rest-api.module';

/**
 * Root module. The realtime broadcaster (QUE-12) is imported so the WebSocket
 * gateway and event-publishing seam are available app-wide; the read-only REST
 * surface for the caller workspace (QUE-19) is imported here too. Command/
 * control endpoints (call-next, serve, transfer, …) are wired in QUE-20.
 */
@Module({
  imports: [RealtimeModule, RestApiModule],
})
export class AppModule {}