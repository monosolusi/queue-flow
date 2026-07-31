import type { ISystemConfigurationRepository } from '../../domain/store-config';

/**
 * The setup-status projection consumed by the gateway first-run guard
 * (FR-WZD-01 / QUE-13). A bare boolean — `isInitialSetupCompleted` — and nothing
 * else: the gateway's nginx `auth_request` probe maps it to an HTTP status (200
 * allow / 403 deny) so nginx can redirect operational routes (`/kiosk`, `/tv`,
 * `/caller`) to `/wizard` before the wizard has run. The full config projection
 * for the wizard/admin panel stays on {@link GetSystemConfigurationUseCase}; this
 * use case is intentionally minimal so the guard's per-request subrequest stays
 * cheap (a single singleton read) and never needs the categories/routing joins.
 */
export interface SetupStatusDto {
  readonly isInitialSetupCompleted: boolean;
}

/**
 * Read-side use case: returns the first-run setup flag only (FR-WZD-01). When no
 * `SystemConfiguration` exists yet (clean store, pre-wizard) it returns
 * `{ isInitialSetupCompleted: false }` rather than throwing — the gateway guard
 * needs a definitive "not configured" answer, not a 500, so the wizard itself
 * (which runs before any config exists) can still boot and be served. Depends
 * only on the {@link ISystemConfigurationRepository} port (DIP): no ORM, HTTP
 * framework, or I/O library (NFR-MNT-01).
 */
export class GetSetupStatusUseCase {
  constructor(private readonly config: ISystemConfigurationRepository) {}

  public async execute(): Promise<SetupStatusDto> {
    const system = await this.config.get();
    return { isInitialSetupCompleted: system ? system.isInitialSetupCompleted : false };
  }
}