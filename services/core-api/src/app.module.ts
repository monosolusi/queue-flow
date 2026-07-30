import { Module } from '@nestjs/common';
import { RealtimeModule } from './interface-adapters/websocket/realtime.module';

/**
 * Root module. Repository providers, use cases, and REST controllers are wired
 * in QUE-9 through QUE-11; the realtime broadcaster (QUE-12) is imported here
 * so the WebSocket gateway and event-publishing seam are available app-wide.
 */
@Module({
  imports: [RealtimeModule],
})
export class AppModule {}