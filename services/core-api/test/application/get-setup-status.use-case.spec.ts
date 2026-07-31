import { Identifier } from '../../src/domain/shared';
import { SystemConfiguration } from '../../src/domain/store-config';
import { GetSetupStatusUseCase } from '../../src/application/store-config';
import { InMemorySystemConfigurationRepository } from '../../src/infrastructure/persistence/in-memory';

describe('GetSetupStatusUseCase (gateway first-run guard — FR-WZD-01)', () => {
  let config: InMemorySystemConfigurationRepository;
  let useCase: GetSetupStatusUseCase;

  beforeEach(() => {
    config = new InMemorySystemConfigurationRepository();
    useCase = new GetSetupStatusUseCase(config);
  });

  it('reports isInitialSetupCompleted:false when no SystemConfiguration exists (clean store)', async () => {
    const result = await useCase.execute();
    expect(result).toEqual({ isInitialSetupCompleted: false });
  });

  it('reports false when a config exists but setup has not been completed', async () => {
    // A freshly created SystemConfiguration has the setup flag false (the
    // wizard has not run completeInitialSetup() yet).
    const system = SystemConfiguration.create(Identifier.generate(), '');
    await config.save(system);

    expect(await useCase.execute()).toEqual({ isInitialSetupCompleted: false });
  });

  it('reports true once the wizard has completed initial setup', async () => {
    const system = SystemConfiguration.create(Identifier.generate(), 'Apotek Sehat');
    system.completeInitialSetup();
    await config.save(system);

    expect(await useCase.execute()).toEqual({ isInitialSetupCompleted: true });
  });
});