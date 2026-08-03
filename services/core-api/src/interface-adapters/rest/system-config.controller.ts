import { Body, Controller, Get, HttpException, Put } from '@nestjs/common';
import {
  GetActiveStateMachineUseCase,
  GetSetupStatusUseCase,
  GetSystemConfigurationUseCase,
  SaveSystemConfigurationUseCase,
  type SaveSystemConfigurationCommand,
} from '../../application/store-config';

/**
 * System-config REST surface for the admin panel + first-run wizard (QUE-30 /
 * FR-WZD-01..06). This controller is the anti-corruption translation point: it
 * turns the HTTP wizard payload into a {@link SaveSystemConfigurationCommand}
 * and maps domain errors to HTTP via the global {@link DomainExceptionFilter}
 * (`InvalidValueObjectException` → 400, `SystemNotConfiguredException` → 409).
 *
 * - `GET /api/system/config` — the full config projection. **Never throws**: a
 *   clean store gets a default-shaped DTO with `isInitialSetupCompleted: false`
 *   so the admin SPA can redirect to `/wizard` and prefill the PRD §7 default
 *   state machine (FR-WZD-01).
 * - `PUT /api/system/config` — the wizard / admin save. One atomic transaction
 *   writes the store profile, state machine, daily-reset policy, categories,
 *   and routing rules, and appends `STATE_SCHEMA_CHANGE` + `ROUTING_CHANGE`
 *   audit entries (NFR-SEC-02). `actor` defaults to `'admin'` (offline LAN,
 *   single manager — no auth; a future auth layer can supply it via header).
 * - `GET /api/system/state-machine` — the active state-machine graph only
 *   (caller projection, FR-CLR-02). 409 until setup is complete.
 */
@Controller('api/system')
export class SystemConfigController {
  constructor(
    private readonly getConfig: GetSystemConfigurationUseCase,
    private readonly saveConfig: SaveSystemConfigurationUseCase,
    private readonly getActiveStateMachine: GetActiveStateMachineUseCase,
    private readonly getSetupStatus: GetSetupStatusUseCase,
  ) {}

  /** `GET /api/system/config` → full config (default-shaped when not yet set up). */
  @Get('config')
  async config() {
    return this.getConfig.execute();
  }

  /** `PUT /api/system/config` → persist the wizard / admin payload atomically. */
  @Put('config')
  async save(@Body() body: SaveSystemConfigurationCommand & { actor?: string }) {
    const command: SaveSystemConfigurationCommand = {
      storeName: body.storeName,
      stateMachine: body.stateMachine,
      dailyReset: body.dailyReset,
      categories: body.categories,
      routingRules: body.routingRules,
      brandColor: body.brandColor,
      actor: body.actor ?? 'admin',
    };
    return this.saveConfig.execute(command);
  }

  /** `GET /api/system/state-machine` → active graph (409 until setup completes). */
  @Get('state-machine')
  async stateMachine() {
    return this.getActiveStateMachine.execute();
  }

  /**
   * `GET /api/system/setup-status` → the gateway first-run guard probe
   * (FR-WZD-01 / QUE-13). nginx `auth_request` only distinguishes 2xx (allow)
   * from 401/403 (deny) — a domain `SystemNotConfiguredException` would map to
   * 409, which `auth_request` treats as a hard error, not a deny — so this
   * route maps the boolean to the HTTP status itself (an interface-adapter
   * concern, kept out of the pure use case). 200 when setup is complete, 403
   * `{ code: 'SETUP_REQUIRED' }` when not. Never throws on a clean store
   * so the wizard (which runs before any config exists) can still boot and the
   * gateway can serve `/admin` + `/wizard` to perform the setup. `HttpException`
   * is used (not `@Res`) to stay platform-agnostic at the Nest layer. The 403
   * uses a distinct `SETUP_REQUIRED` code (not the domain
   * `SYSTEM_NOT_CONFIGURED` that {@link DomainExceptionFilter} maps to 409) so
   * the gateway-guard deny is unambiguous and not confused with a 409 domain
   * error from the queue command surface.
   */
  @Get('setup-status')
  async setupStatus() {
    const { isInitialSetupCompleted } = await this.getSetupStatus.execute();
    if (isInitialSetupCompleted) {
      return { isInitialSetupCompleted: true };
    }
    throw new HttpException(
      { code: 'SETUP_REQUIRED', isInitialSetupCompleted: false },
      403,
    );
  }
}