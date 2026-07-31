import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe (QUE-30). `GET /api/health` → `{ status: 'ok' }`. Used by the
 * power-cut recovery acceptance harness to poll for boot after spawning
 * `core-api` as a child process. Pure passthrough — no domain dependency, no
 * persistence — so it answers even before the first-run wizard has configured
 * the system.
 */
@Controller('api/health')
export class HealthController {
  @Get()
  status() {
    return { status: 'ok' };
  }
}