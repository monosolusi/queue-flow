import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type ISystemConfigurationRepository,
  SYSTEM_CONFIGURATION_REPOSITORY,
} from '../../domain/store-config';

/**
 * Eager first-run bootstrap checker (FR-WZD-01 / QUE-13 AC "config re-readable
 * at startup"). On boot it reads the singleton `SystemConfiguration` from the
 * active persistence profile and logs the setup outcome, so a restart visibly
 * re-reads the persisted config — proving AC #2 holds for the real PostgreSQL
 * profile (the in-memory profile is dev/test-only and loses config by design).
 *
 * This service does **not** cache or publish the config: per-execution
 * transition-policy resolution and the `GET /api/system/setup-status` gateway
 * probe still read the repository directly (a cheap singleton read), so a
 * wizard save always observes fresh state on the very next request. It is the
 * named "bootstrap checker" from QUE-13's proposed solution — an observable,
 * eager startup read — nothing more.
 *
 * Lives in infrastructure: it owns boot I/O (a framework `OnModuleInit` hook),
 * so it must not live in domain or application. dep-cruiser permits
 * infrastructure → domain.
 */
@Injectable()
export class BootstrapService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapService.name);

  constructor(
    @Inject(SYSTEM_CONFIGURATION_REPOSITORY)
    private readonly systemConfig: ISystemConfigurationRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const system = await this.systemConfig.get();
    if (system?.isInitialSetupCompleted) {
      this.logger.log(`System configuration loaded — setup complete (store: "${system.storeName}").`);
    } else if (system) {
      this.logger.warn('System configuration exists but initial setup is not complete — first-run wizard required.');
    } else {
      this.logger.warn('No system configuration found — first-run wizard required (redirect operational routes to /wizard).');
    }
  }
}