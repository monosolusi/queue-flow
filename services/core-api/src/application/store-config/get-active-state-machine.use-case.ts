import type { ISystemConfigurationRepository } from '../../domain/store-config';
import { SystemNotConfiguredException } from '../../domain/shared';
import { type StateMachineDto, projectStateMachine } from './get-system-configuration.use-case';

/**
 * Read-side use case: returns the **active** state-machine graph (states +
 * transitions + action labels) as a flat {@link StateMachineDto} — the
 * read-only projection the caller panel consumes to render its dynamic action
 * buttons (FR-CLR-02). ISP: the caller gets only this graph, never the full
 * `SystemConfiguration` or any admin/reporting DTO.
 *
 * Throws {@link SystemNotConfiguredException} (→ 409) when the system is not
 * yet configured / setup-incomplete, so the caller surfaces "not configured"
 * rather than rendering buttons against a default graph it has no real config
 * for — consistent with the other queue endpoints' pre-setup behavior.
 *
 * Depends only on the {@link ISystemConfigurationRepository} port (DIP): no ORM,
 * HTTP framework, or I/O library (NFR-MNT-01).
 */
export class GetActiveStateMachineUseCase {
  constructor(private readonly config: ISystemConfigurationRepository) {}

  public async execute(): Promise<StateMachineDto> {
    const system = await this.config.get();
    if (!system || !system.isInitialSetupCompleted) {
      throw new SystemNotConfiguredException();
    }
    return projectStateMachine(system.stateMachine);
  }
}