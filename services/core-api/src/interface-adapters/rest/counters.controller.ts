import { Controller, Get } from '@nestjs/common';
import { ListCountersUseCase } from '../../application/store-config';

/**
 * Read-only REST surface for counter master data (FR-CLR-01 / QUE-19). The
 * caller panel fetches this list to render the counter selection screen on
 * first open. Command/control endpoints (call-next, serve, …) arrive in QUE-20;
 * this controller exposes only the read the workspace needs to bind a counter.
 *
 * Path prefix `api/` keeps the public REST surface under `/api/*`, distinct
 * from the `/ws` WebSocket path and (in deployment) the `/caller` static
 * origin fronted by NGINX.
 */
@Controller('api/counters')
export class CountersController {
  constructor(private readonly listCounters: ListCountersUseCase) {}

  /** `GET /api/counters` → the configured counters with assigned categories. */
  @Get()
  list() {
    return this.listCounters.execute();
  }
}