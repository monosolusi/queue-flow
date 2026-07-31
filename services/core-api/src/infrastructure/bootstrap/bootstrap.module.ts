import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module';
import { BootstrapService } from './bootstrap.service';

/**
 * Wires the eager first-run bootstrap checker (QUE-13). {@link PersistenceModule}
 * supplies the {@link SYSTEM_CONFIGURATION_REPOSITORY} token the service reads at
 * boot. Kept separate from {@link SchedulerModule} (which also reads the config
 * at boot) by concern: the scheduler arms the daily-reset cron; the bootstrap
 * service only verifies + logs setup status (the "bootstrap checker" from
 * QUE-13's proposed solution).
 */
@Module({
  imports: [PersistenceModule.forRoot()],
  providers: [BootstrapService],
})
export class BootstrapModule {}