import { Module } from '@nestjs/common';

/**
 * Root module. Intentionally empty for QUE-8 — repository providers,
 * use cases, controllers, and gateways are wired in QUE-9 through QUE-12.
 */
@Module({})
export class AppModule {}