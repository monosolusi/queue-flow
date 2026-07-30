import type { ITransitionPolicy, StatusValue } from '../../domain/queue';
import type { ISystemConfigurationRepository } from '../../domain/store-config';
import {
  InvalidStateTransitionException,
  SystemNotConfiguredException,
} from '../../domain/shared';

/**
 * The state transition validator / active-policy resolver (QUE-10 AC#1 —
 * "Validator membaca konfigurasi state machine aktif").
 *
 * Reads the singleton {@link SystemConfiguration} and yields its active
 * `StateMachine` as the {@link ITransitionPolicy} the queue action use cases
 * validate every transition against. All queue control actions share this one
 * validator (AC#3 — "Queue control actions memanfaatkan validator yang sama"):
 * use cases receive the resolved `ITransitionPolicy` directly and never load
 * configuration themselves, per the application-layer DIP convention.
 *
 * Lives in the interface-adapter / DI layer: it is the seam between the Store
 * Config context (where the active state machine is configured) and the Queue
 * use cases (which depend only on the `ITransitionPolicy` port). Concrete NestJS
 * wiring (providing the resolved policy to use cases) is added in QUE-11.
 */
export class StateTransitionValidator {
  constructor(private readonly config: ISystemConfigurationRepository) {}

  /**
   * Resolves the active transition policy from the persisted system
   * configuration. Throws {@link SystemNotConfiguredException} when no
   * configuration exists yet (first-run guard, FR-WZD-01) — queue control is
   * unavailable until the wizard completes.
   */
  public async getActivePolicy(): Promise<ITransitionPolicy> {
    const system = await this.config.get();
    if (!system) {
      throw new SystemNotConfiguredException();
    }
    return system.stateMachine;
  }

  /**
   * Convenience validation: resolves the active policy and throws
   * {@link InvalidStateTransitionException} when `from -> to` is not an allowed
   * edge (AC#2 — "Transisi ilegal melempar error yang konsisten"). Interface
   * adapters may call this to reject an illegal action before touching a use
   * case; use cases re-check inline against the injected policy.
   */
  public async assertAllowed(from: StatusValue, to: StatusValue): Promise<void> {
    const policy = await this.getActivePolicy();
    if (!policy.isAllowed(from, to)) {
      throw new InvalidStateTransitionException(from, to);
    }
  }
}