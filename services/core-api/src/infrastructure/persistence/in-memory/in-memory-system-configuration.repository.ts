import {
  ISystemConfigurationRepository,
  SystemConfiguration,
} from '../../../domain/store-config';

/**
 * In-memory implementation of {@link ISystemConfigurationRepository}. Holds the
 * singleton configuration aggregate for the process lifetime.
 */
export class InMemorySystemConfigurationRepository
  implements ISystemConfigurationRepository
{
  private config: SystemConfiguration | null = null;

  async get(): Promise<SystemConfiguration | null> {
    return this.config;
  }

  async save(config: SystemConfiguration): Promise<void> {
    this.config = config;
  }

  /** Test/dev-only: drops the held configuration. Not on the port interface. */
  clear(): void {
    this.config = null;
  }
}