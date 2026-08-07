import { BadRequestException, Body, Controller, Get, HttpException, Put, Req, UseGuards } from '@nestjs/common';
import {
  GetActiveStateMachineUseCase,
  GetSetupStatusUseCase,
  GetSystemConfigurationUseCase,
  SaveSystemConfigurationUseCase,
  type SaveSystemConfigurationCommand,
} from '../../application/store-config';
import { Role, type AuthenticatedPrincipal } from '../../domain/identity';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOrSetupGuard } from '../auth/admin-or-setup.guard';

/** Minimal structural shape of an Express request with the guard-attached
 *  principal — avoids a `@types/express` dep. */
interface HttpRequestWithPrincipal {
  user?: AuthenticatedPrincipal;
}

/**
 * Required top-level fields on a `PUT /api/system/config` payload. The value
 * objects / use case validate each field's *format* when present, but a missing
 * field dereferences `undefined` (e.g. `[...undefined]`, `undefined.trim()`)
 * and surfaces as a 500 `TypeError` — so the controller guards *presence* at
 * the transport boundary and returns 400 instead. `actor` is NOT a body field
 * — it is the authenticated admin's username (QUE-43), threaded from the guard
 * (or the `'system'` sentinel on the pre-setup wizard path). `brandColor` is
 * required on the wire (QUE-36 made it part of the config graph).
 */
const REQUIRED_CONFIG_FIELDS: ReadonlyArray<keyof SaveSystemConfigurationCommand> = [
  'storeName',
  'stateMachine',
  'dailyReset',
  'categories',
  'routingRules',
  'brandColor',
  'serviceThemes',
];

/**
 * Expected top-level *shape* of each required field. Presence is guarded
 * separately; this catches a present-but-wrong-type field (e.g.
 * `stateMachine: "WAITING"`, `categories: 1`) that would otherwise reach the
 * use case and surface as a 500 `TypeError` — e.g. `[...dto.states]` on a
 * string, or `for (const dto of dtos)` on a number — *before* the domain value
 * objects can throw a clean `InvalidValueObjectException` (→ 400). Shallow by
 * design: deep format / semantic validation stays in the domain value objects
 * (SRP). The controller is the anti-corruption translation point, so transport
 * shape validation belongs here, not in the use case.
 */
const CONFIG_FIELD_SHAPES: ReadonlyArray<{
  field: keyof SaveSystemConfigurationCommand;
  kind: 'string' | 'array' | 'object';
}> = [
  { field: 'storeName', kind: 'string' },
  { field: 'brandColor', kind: 'string' },
  { field: 'stateMachine', kind: 'object' },
  { field: 'dailyReset', kind: 'object' },
  { field: 'categories', kind: 'array' },
  { field: 'routingRules', kind: 'array' },
  { field: 'serviceThemes', kind: 'object' },
];

/** True when `value` does not match the expected `kind` (object = plain object, not array). */
function shapeMismatch(value: unknown, kind: 'string' | 'array' | 'object'): boolean {
  if (kind === 'string') return typeof value !== 'string';
  if (kind === 'array') return !Array.isArray(value);
  return typeof value !== 'object' || Array.isArray(value) || value === null;
}

/**
 * Nested-shape errors for the config payload's iterable / string-scalar
 * sub-fields. The domain value objects (`StateSchema`, `StateTransitionRule`,
 * `DailyResetPolicy`) are typed to accept `string` and call `.trim()` /
 * spread / `.map` on their inputs — they trust their type contract and do NOT
 * defend non-string / non-iterable runtime input (that would pollute the pure
 * domain layer with `typeof` guards, violating NFR-MNT-01). So a direct API
 * call sending `stateMachine: { states: 5 }` or `dailyReset: { cronExpression:
 * 5 }` reaches the use case and `Typeerror`s (500) *before* a value object can
 * throw a clean `InvalidValueObjectException` (400). The controller — the
 * anti-corruption boundary — guards these nested shapes so a malformed payload
 * is 400, not an unhandled 500 (exception leakage). Deep semantic validation
 * (enum membership, state-name uniqueness, cron grammar, duplicate codes)
 * stays in the domain value objects + use case (SRP).
 *
 * Only the sub-fields that would crash are guarded — silent semantic accepts
 * (e.g. a non-enum `mode` that falls through to MANUAL) are the VOs'/use-case's
 * job, not the crash class this guard closes.
 */
function configNestedShapeErrors(body: Partial<SaveSystemConfigurationCommand>): string[] {
  const errs: string[] = [];
  const sm = body.stateMachine;
  if (sm != null && typeof sm === 'object' && !Array.isArray(sm)) {
    if (!Array.isArray(sm.states) || !sm.states.every((s: string) => typeof s === 'string')) {
      errs.push('stateMachine.states must be an array of strings');
    }
    if (
      !Array.isArray(sm.transitions) ||
      !sm.transitions.every(
        (t) =>
          t != null &&
          typeof t === 'object' &&
          !Array.isArray(t) &&
          typeof t.from === 'string' &&
          typeof t.to === 'string' &&
          typeof t.actionLabel === 'string',
      )
    ) {
      errs.push('stateMachine.transitions must be an array of { from, to, actionLabel: string }');
    }
  }
  const dr = body.dailyReset;
  if (dr != null && typeof dr === 'object' && !Array.isArray(dr)) {
    if (dr.cronExpression != null && typeof dr.cronExpression !== 'string') {
      errs.push('dailyReset.cronExpression must be a string or null');
    }
    // `timezone` is optional (defaults to the server TZ when null/undefined),
    // but a non-string value (e.g. `5`) reaches `DailyResetPolicy.of` which
    // calls `.trim()` on it → TypeError 500 before the VO can throw.
    if (dr.timezone != null && typeof dr.timezone !== 'string') {
      errs.push('dailyReset.timezone must be a string or null');
    }
  }
  if (Array.isArray(body.categories)) {
    // Elements are validated as `unknown` — the HTTP body is untrusted, so the
    // declared `WizardCategoryDto` type is not yet earned at this boundary.
    (body.categories as readonly unknown[]).forEach((c, i) => {
      // A non-object element (e.g. `null`) crashes the use case on `.code`
      // access before any value object can throw.
      if (c == null || typeof c !== 'object' || Array.isArray(c)) {
        errs.push(`categories[${i}] must be a plain object`);
        return;
      }
      // A non-string `name` (e.g. `5`) crashes the `Category` ctor's `.trim()`
      // before it can throw InvalidValueObjectException. `code`/`id` are safe —
      // `code` is regex-tested with coercion (→ 400), `id` via `Identifier.of`
      // (→ 400) — so only `name` needs a crash guard here.
      const name = (c as { name?: unknown }).name;
      if (name != null && typeof name !== 'string') {
        errs.push(`categories[${i}].name must be a string`);
      }
    });
  }
  if (Array.isArray(body.routingRules)) {
    (body.routingRules as readonly unknown[]).forEach((r, i) => {
      // A non-object element (e.g. `null`/`5`) crashes the use case on
      // `.counterId`/`.assignedCategoryCodes` access before any VO can throw —
      // reject it at the boundary instead of silently skipping.
      if (r == null || typeof r !== 'object' || Array.isArray(r)) {
        errs.push(`routingRules[${i}] must be a plain object`);
        return;
      }
      const codes = (r as { assignedCategoryCodes?: unknown }).assignedCategoryCodes;
      if (!Array.isArray(codes) || !codes.every((cc: unknown) => typeof cc === 'string')) {
        errs.push(`routingRules[${i}].assignedCategoryCodes must be an array of strings`);
      }
    });
  }
  return errs;
}

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

  /**
   * `PUT /api/system/config` → persist the wizard / admin payload atomically.
   * Guarded by {@link AdminOrSetupGuard}: the first-run wizard may save while
   * `isInitialSetupCompleted` is false (no session — the wizard runs before any
   * user exists); post-setup, an authenticated `admin` session is required. The
   * audit `actor` is the authenticated admin's username (QUE-43, replacing the
   * former `body.actor` forgery vector); on the pre-setup wizard path there is
   * no principal, so the actor falls back to the `'system'` sentinel — that
   * first-save is the setup act itself, attributable to the system, not a user.
   */
  @Put('config')
  @UseGuards(AdminOrSetupGuard)
  async save(@Body() body: Partial<SaveSystemConfigurationCommand>, @Req() request: HttpRequestWithPrincipal) {
    // Guard presence of every required top-level field at the boundary so a
    // malformed payload yields 400 (not a 500 TypeError when the use case
    // dereferences `undefined`). Format validation stays in the value objects.
    const missing = REQUIRED_CONFIG_FIELDS.filter((f) => body[f] == null);
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required config field(s): ${missing.join(', ')}`);
    }
    // Guard the *shape* of each required field so a present-but-wrong-type
    // value (e.g. `stateMachine: "WAITING"`, `categories: 1`) also yields 400
    // instead of a 500 TypeError from the use case (e.g. `[...dto.states]` on
    // a string) before the value objects can throw. Deep validation stays in
    // the value objects.
    const malformed = CONFIG_FIELD_SHAPES.filter((s) => shapeMismatch(body[s.field], s.kind)).map(
      (s) => `${s.field} must be a ${s.kind === 'object' ? 'plain object' : s.kind}`,
    );
    if (malformed.length > 0) {
      throw new BadRequestException(`Malformed config field(s): ${malformed.join(', ')}`);
    }
    // Guard nested iterable / string-scalar sub-fields that would TypeError
    // (500) before a value object can throw — e.g. `stateMachine: { states: 5
    // }` (`[...5]`), `dailyReset: { cronExpression: 5 }` (`(5).trim()`), or
    // `routingRules: [{ assignedCategoryCodes: 5 }]` (`(5).map`). Deep semantic
    // validation stays in the value objects + use case.
    const nestedErrors = configNestedShapeErrors(body);
    if (nestedErrors.length > 0) {
      throw new BadRequestException(`Malformed config field(s): ${nestedErrors.join(', ')}`);
    }
    const principal = request.user as AuthenticatedPrincipal | undefined;
    const command: SaveSystemConfigurationCommand = {
      storeName: body.storeName!,
      stateMachine: body.stateMachine!,
      dailyReset: body.dailyReset!,
      categories: body.categories!,
      routingRules: body.routingRules!,
      brandColor: body.brandColor!,
      serviceThemes: body.serviceThemes!,
      actor: principal?.username ?? 'system',
    };
    return this.saveConfig.execute(command);
  }

  /**
   * `GET /api/system/state-machine` → active graph (409 until setup completes).
   * Authenticated (admin or caller-staff) — the caller panel reads this on boot
   * to render its dynamic action buttons (FR-CLR-02); pre-setup it 409s via the
   * use case's `SystemNotConfiguredException` regardless of auth.
   */
  @Get('state-machine')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.ADMIN, Role.CALLER_STAFF)
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