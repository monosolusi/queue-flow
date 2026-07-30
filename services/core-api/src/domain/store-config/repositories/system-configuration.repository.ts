import type { SystemConfiguration } from '../system-configuration.aggregate';

/**
 * Repository abstraction for the singleton {@link SystemConfiguration} aggregate
 * (FR-WZD-06 persistence + first-run bootstrap guard, QUE-13).
 */
export interface ISystemConfigurationRepository {
  get(): Promise<SystemConfiguration | null>;
  save(config: SystemConfiguration): Promise<void>;
}