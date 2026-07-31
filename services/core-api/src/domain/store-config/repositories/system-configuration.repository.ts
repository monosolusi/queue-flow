import type { SystemConfiguration } from '../system-configuration.aggregate';

/**
 * NestJS DI token for {@link ISystemConfigurationRepository}. Interfaces are
 * erased at runtime, so consumers inject the port by this Symbol rather than by
 * type metadata. A plain language builtin — no framework import — so it does not
 * compromise domain purity (NFR-MNT-01), mirroring the other repository tokens.
 */
export const SYSTEM_CONFIGURATION_REPOSITORY = Symbol('SYSTEM_CONFIGURATION_REPOSITORY');

/**
 * Repository abstraction for the singleton {@link SystemConfiguration} aggregate
 * (FR-WZD-06 persistence + first-run bootstrap guard, QUE-13).
 */
export interface ISystemConfigurationRepository {
  get(): Promise<SystemConfiguration | null>;
  save(config: SystemConfiguration): Promise<void>;
}