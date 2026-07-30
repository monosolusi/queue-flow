import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

/**
 * Bootstrap for core-api-service. The WebSocket server (QUE-12) uses the `ws`
 * platform adapter — native WebSocket on the same port as HTTP (3000), routed
 * at `/ws` — for low-latency LAN broadcasts (NFR-PERF-02). HTTP routes and DB
 * wiring arrive in QUE-9+ / QUE-27-28.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(3000);
}

void bootstrap();