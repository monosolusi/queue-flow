import { Logger } from '@nestjs/common';
import { Identifier } from '../../src/domain/shared';
import { SystemConfiguration } from '../../src/domain/store-config';
import { BootstrapService } from '../../src/infrastructure/bootstrap/bootstrap.service';
import { InMemorySystemConfigurationRepository } from '../../src/infrastructure/persistence/in-memory';

describe('BootstrapService (first-run bootstrap checker — QUE-13)', () => {
  let config: InMemorySystemConfigurationRepository;

  beforeEach(() => {
    config = new InMemorySystemConfigurationRepository();
    // Silence the real Logger so the spec output stays clean.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('logs the no-config branch without throwing on a clean store', async () => {
    const service = new BootstrapService(config);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('logs the incomplete-setup branch when a config exists but setup is not done', async () => {
    await config.save(SystemConfiguration.create(Identifier.generate(), ''));
    const service = new BootstrapService(config);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('logs the setup-complete branch once the wizard has finalized config', async () => {
    const system = SystemConfiguration.create(Identifier.generate(), 'Apotek Sehat');
    system.completeInitialSetup();
    await config.save(system);
    const service = new BootstrapService(config);
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});