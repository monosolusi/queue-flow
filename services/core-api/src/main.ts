import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Minimal bootstrap for core-api-service. HTTP routes, DB wiring, and
 * WebSocket server are added in QUE-9/QUE-12 and QUE-27/QUE-28 — not here.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();