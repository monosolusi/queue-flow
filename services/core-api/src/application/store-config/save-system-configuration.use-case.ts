import type { ISystemConfigurationRepository } from '../../domain/store-config';
import type { ICounterRoutingRuleRepository } from '../../domain/store-config';
import type { ICategoryRepository } from '../../domain/queue';
import { Category } from '../../domain/queue';
import { CounterRoutingRule } from '../../domain/store-config';
import { SystemConfiguration } from '../../domain/store-config';
import { StateMachine } from '../../domain/store-config';
import { StateSchema } from '../../domain/store-config';
import { StateDescriptions } from '../../domain/store-config';
import { StateTransitionRule } from '../../domain/store-config';
import { DailyResetPolicy, DailyResetMode } from '../../domain/store-config';
import { BrandColor } from '../../domain/store-config';
import { ServiceThemes, type ServiceThemesMap } from '../../domain/store-config';
import { TvPanelLayout, type TvGridLayout } from '../../domain/store-config';
import { EdgeRoutingLayout, type EdgeRoutingLayoutDto } from '../../domain/store-config';
import { NodePositions, type NodePositionsDto } from '../../domain/store-config';
import { NodeActions, type NodeActionsDto } from '../../domain/store-config';
import { TerminalNodes, type TerminalNodesDto } from '../../domain/store-config';
import { PrinterConfiguration, type PrinterConfigurationDto } from '../../domain/store-config';
import { type IDailyResetSchedulerPort } from '../../domain/store-config';
import {
  Identifier,
  InvalidValueObjectException,
  type IEventDispatcher,
  type ITransactionManager,
  NoOpTransactionManager,
  type PriorityPolicy,
} from '../../domain/shared';
import { AuditAction, toSnapshot } from '../../domain/audit';
import { type RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
import { SystemConfigurationChangedEvent } from '../../domain/store-config';
import {
  type ConfigCategoryDto,
  type ConfigRoutingRuleDto,
  type StateMachineDto,
  projectStateMachine,
} from './get-system-configuration.use-case';

/** One category in the wizard payload. `id` is optional (generated if absent). */
export interface WizardCategoryDto {
  readonly id?: string;
  readonly code: string;
  readonly name: string;
}

/**
 * One counter routing rule in the wizard payload. Categories are referenced by
 * **code** (stable across the payload) rather than id, so the wizard does not
 * need to track generated ids while editing.
 */
export interface WizardRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryCodes: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

export interface WizardStateMachineDto {
  readonly states: readonly string[];
  readonly transitions: readonly { from: string; to: string; actionLabel: string }[];
  /**
   * Per-state editable descriptions (intrinsic per-state metadata, part of the
   * state-machine definition). Optional on the wire for backward-compat with
   * direct API calls / existing tests that omit it — the VO recovers
   * `undefined` to the empty default (derive from canonical copy). Travels
   * INSIDE the `stateMachine` object (NOT a top-level field), so
   * `REQUIRED_CONFIG_FIELDS` needs no new entry and the payload-only
   * passthrough sites (PrinterConfigPage/TvLayoutPage/wizard) need no new
   * passthrough — they already pass `stateMachine` through. Not change-gated
   * for audit (mirrors `nodePositions`/`nodeActions`).
   */
  readonly descriptions?: Record<string, string>;
}

export interface WizardDailyResetDto {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
  /**
   * IANA timezone the daily-reset cron fires in (e.g. `Asia/Jakarta`). Optional
   * on the wire for backward-compat with direct API calls / existing tests that
   * omit it — the VO defaults to the server's local TZ when absent. The admin /
   * wizard client always sends it (QUE-42).
   */
  readonly timezone?: string;
}

/**
 * The full wizard payload (FR-WZD-02..05). One atomic save writes the store
 * profile, state machine, daily-reset policy, category master data, and counter
 * routing rules. `actor` is recorded on the audit entries (NFR-SEC-02).
 */
export interface SaveSystemConfigurationCommand {
  readonly storeName: string;
  readonly stateMachine: WizardStateMachineDto;
  readonly dailyReset: WizardDailyResetDto;
  readonly categories: readonly WizardCategoryDto[];
  readonly routingRules: readonly WizardRoutingRuleDto[];
  readonly brandColor: string;
  /** Per-service light/dark theme map (QUE-47). Required on the wire; the VO
   *  defaults any missing surface to `'light'` and rejects a present-but-invalid
   *  value. Not change-gated (like `brandColor`). */
  readonly serviceThemes: ServiceThemesMap;
  /** Per-widget TV grid layout (an ordered array of placed widgets). Required
   *  on the wire; the VO recovers a null/undefined to the default and rejects a
   *  present-but-invalid widget (bad id/component, out-of-range x/y/w/h,
   *  duplicate id, overlapping rectangles). Not change-gated (like
   *  `brandColor`/`serviceThemes`). */
  readonly tvPanelLayout: TvGridLayout;
  /** Per-edge connection-point (handle) layout for the admin state-machine
   *  visual editor (sparse keyed map "from->to" -> { sourceSide, targetSide }).
   *  Required on the wire; the VO recovers a null/undefined to the empty default
   *  (all-default routing) and rejects a present-but-invalid entry. Not
   *  change-gated (like `brandColor`/`serviceThemes`/`tvPanelLayout`). */
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  /** Per-state node x/y positions for the admin state-machine visual editor
   *  (keyed map "stateName" -> { x, y }). Non-sparse: every state whose position
   *  is known has an entry. Required on the wire; the VO recovers a
   *  null/undefined to the empty default (autoLayout) and rejects a
   *  present-but-invalid entry (non-finite x/y). Not change-gated (like
   *  `edgeRoutingLayout`/`brandColor`/`serviceThemes`/`tvPanelLayout`). */
  readonly nodePositions: NodePositionsDto;
  /** Per-state Kaleo-style node-level actions for the admin state-machine
   *  editor (keyed map "stateName" -> NodeActionProps[]). Decoupled from
   *  transitions (Kaleo parity): an action is a node-level
   *  `{ executionType, type, value }` triple, NOT a per-edge `{label, target}`.
   *  Required on the wire; the VO recovers a null/undefined to the empty default
   *  (no node-level actions) and rejects a present-but-invalid entry (non-array
   *  value, bad `executionType`/`type` enum, non-string/empty `value`). Not
   *  change-gated (like `nodePositions`/`edgeRoutingLayout`/`brandColor`).
   *  Not audited (admin-only config, not in the NFR-SEC-02 list). */
  readonly nodeActions: NodeActionsDto;
  /** Persisted Start/End terminal-node presence + position for the admin
   *  state-machine editor (fixed-shape `{ start, end }`; each terminal is
   *  `'auto'` | `'hidden'` | `{ x, y }`). Required on the wire; the VO recovers
   *  a null/undefined to the auto/auto default (markers render at derived
   *  positions) and rejects a present-but-malformed value. NO state-membership
   *  cross-check (terminal ids `__start`/`__end` are not state names — that is
   *  the whole reason this is a dedicated field, unlike `nodePositions`/
   *  `nodeActions`). Not change-gated (like `nodePositions`/`nodeActions`).
   *  Not audited (admin-only config, not in the NFR-SEC-02 list). */
  readonly terminalNodes: TerminalNodesDto;
  /** Printer configuration (which printer the kiosk uses — Chrome's default
   *  dialog, or a network ESC/POS printer proxied through core-api over raw
   *  TCP). Required on the wire; the VO recovers a null/undefined to the chrome
   *  default (zero behavior change) and rejects a present-but-invalid value
   *  (bad mode/paperWidth/cutMode enum, non-integer port, network-escpos with
   *  no host). Not change-gated (like `nodePositions`/`edgeRoutingLayout`).
   *  Not audited (operational config, not in the NFR-SEC-02 list). */
  readonly printerConfiguration: PrinterConfigurationDto;
  readonly actor: string;
}

export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly brandColor: string;
  readonly serviceThemes: ServiceThemesMap;
  readonly tvPanelLayout: TvGridLayout;
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  readonly nodePositions: NodePositionsDto;
  readonly nodeActions: NodeActionsDto;
  readonly terminalNodes: TerminalNodesDto;
  readonly printerConfiguration: PrinterConfigurationDto;
}

/** Minimal projection used only for audit before/after snapshots. */
function categorySnapshot(c: Category): ConfigCategoryDto {
  return { id: c.id.value, code: c.code, name: c.name };
}
function routingSnapshot(r: CounterRoutingRule): ConfigRoutingRuleDto {
  return {
    counterId: r.counterId,
    counterName: r.counterName,
    assignedCategoryIds: [...r.assignedCategoryIds],
    priorityPolicy: r.priorityPolicy,
  };
}
/**
 * Minimal projection of a {@link DailyResetPolicy} for the
 * `DAILY_RESET_POLICY_CHANGE` audit before/after snapshot (QUE-32). Carries
 * the four policy scalars as a plain object so the audit row is self-describing
 * without serializing the value object.
 */
function dailyResetPolicySnapshot(p: DailyResetPolicy): {
  mode: DailyResetMode;
  cronExpression: string | null;
  resetTicketNumberTo: number;
  archivePreviousDayData: boolean;
  timezone: string;
} {
  return {
    mode: p.mode,
    cronExpression: p.cronExpression,
    resetTicketNumberTo: p.resetTicketNumberTo,
    archivePreviousDayData: p.archivePreviousDayData,
    timezone: p.timezone,
  };
}

/**
 * The wizard / admin save (FR-WZD-02..06). Validates and persists the full
 * system configuration in **one** {@link ITransactionManager.runInTransaction}
 * block: the categories and routing rules are fully replaced (deleteAll + save
 * each), the singleton `SystemConfiguration` is reconstituted with the new state
 * machine + daily-reset policy + store name, and `completeInitialSetup()` flips
 * the setup flag (idempotent on re-edit). Two audit entries are appended inside
 * the same tx — `STATE_SCHEMA_CHANGE` (state-machine before/after) and
 * `ROUTING_CHANGE` (categories + routings before/after) — so a power cut leaves
 * either the whole configuration committed or nothing (NFR-REL-02 / NFR-SEC-02).
 * A third entry, `DAILY_RESET_POLICY_CHANGE`, is appended **only when the
 * daily-reset policy actually changed** (before/after scalar snapshot) — so a
 * policy-only edit has its own audit action, and an edit that leaves the policy
 * untouched records nothing spurious (QUE-32 / NFR-SEC-02).
 *
 * After the tx commits, when the daily-reset policy changed (or this is the
 * initial setup), the use case calls {@link IDailyResetSchedulerPort.reArm} so
 * the running cron reflects the new policy without a process restart (QUE-32 /
 * FR-ADM-01). Re-arm is post-commit by design: a rolled-back save never re-arms
 * to an un-persisted policy (NFR-REL-02), the same dispatch-after-commit pattern
 * the daily-reset engine uses for `SYSTEM_RESET`.
 *
 * Also post-commit, the use case broadcasts a {@link SystemConfigurationChangedEvent}
 * so connected caller panels refetch the active state machine and reflect the
 * admin-designed flow + its `actionLabel` wording without a page reload
 * (FR-CLR-02). Without this, a mid-session reconfiguration leaves a caller
 * panel on a stale snapshot — rendering removed transitions as buttons that
 * 409 on tap and hiding newly added / relabeled ones.
 *
 * `recordAudit`, `txManager`, `scheduler`, and `dispatcher` are optional with
 * no-op/null defaults, so unit tests can construct the use case directly with
 * just the three repository ports. Depends only on ports (DIP): no ORM, HTTP
 * framework, or I/O library (NFR-MNT-01). The `dispatcher` port lives in the
 * shared kernel (`IEventDispatcher`), so this Store Config use case never
 * reaches into the Queue context's application layer to broadcast — the
 * interface-adapter layer wires the Queue-owned `QueueEventDispatcher` under
 * the shared token. The controller is the anti-corruption translation point
 * that turns the HTTP wizard payload into this command.
 */
export class SaveSystemConfigurationUseCase {
  constructor(
    private readonly config: ISystemConfigurationRepository,
    private readonly categories: ICategoryRepository,
    private readonly routingRules: ICounterRoutingRuleRepository,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly scheduler: IDailyResetSchedulerPort | null = null,
    /**
     * Broadcasts {@link SystemConfigurationChangedEvent} post-commit so connected
     * caller panels refetch the active state machine and reflect the new flow +
     * `actionLabel` wording without a reload (FR-CLR-02). Optional with a null
     * default so unit tests construct the use case with the three repository
     * ports alone; the interface-adapter layer wires the
     * {@link IEventDispatcher} port (the Queue-owned `QueueEventDispatcher` is
     * the concrete implementation). The port lives in the shared kernel, so
     * this Store Config use case depends on the abstraction, not on a
     * Queue-owned concrete class (DIP / bounded-context anti-corruption).
     */
    private readonly dispatcher: IEventDispatcher | null = null,
  ) {}

  public async execute(
    command: SaveSystemConfigurationCommand,
  ): Promise<SaveSystemConfigurationResult> {
    // 1. Build + validate the domain objects (throws InvalidValueObjectException
    //    on bad input — the controller maps that to 400). Done BEFORE opening the
    //    transaction so a malformed payload fails fast without acquiring a tx.
    const stateMachine = this.buildStateMachine(command.stateMachine);
    const dailyResetPolicy = DailyResetPolicy.of(
      command.dailyReset.mode,
      command.dailyReset.cronExpression,
      command.dailyReset.resetTicketNumberTo,
      command.dailyReset.archivePreviousDayData,
      command.dailyReset.timezone,
    );
    // Brand color is a pure config field — no scheduler/audit side-effect, so no
    // change-gating flag or post-commit re-arm (unlike the daily-reset policy).
    // Validated here (fail-fast, pre-tx) so a malformed color never acquires a tx.
    const brandColor = BrandColor.of(command.brandColor);
    // Per-service themes — same shape: pure appearance, not change-gated, no
    // post-commit side-effect. Validated pre-tx so a malformed map fails fast.
    const serviceThemes = ServiceThemes.of(command.serviceThemes);
    // Per-widget TV grid layout — same shape: pure appearance, not
    // change-gated, no post-commit side-effect. Validated pre-tx so a
    // malformed layout (bad widget, duplicate id, overlapping rectangles)
    // fails fast.
    const tvPanelLayout = TvPanelLayout.of(command.tvPanelLayout);
    // Per-edge connection-point layout — same shape: pure appearance, not
    // change-gated, no post-commit side-effect. Validated pre-tx so a malformed
    // layout (bad side enum, non-object value) fails fast.
    const edgeRoutingLayout = EdgeRoutingLayout.of(command.edgeRoutingLayout);
    // Per-state node positions — same shape: pure appearance, not change-gated,
    // no post-commit side-effect. Validated pre-tx so a malformed map (non-object
    // value, non-finite x/y) fails fast.
    const nodePositions = NodePositions.of(command.nodePositions);
    // Per-state node actions — same shape: pure admin config, not change-gated,
    // no post-commit side-effect. Validated pre-tx so a malformed map (non-array
    // value, bad executionType/type enum, non-string/empty value) fails fast.
    const nodeActions = NodeActions.of(command.nodeActions);
    // Terminal nodes (Start/End markers) — same shape: pure admin appearance,
    // not change-gated, no post-commit side-effect. Validated pre-tx so a
    // malformed map (non-object raw, bad terminal value, non-finite x/y) fails
    // fast. NO state-membership cross-check here — terminal ids `__start`/
    // `__end` are not state names (the whole reason this is a dedicated field,
    // unlike `nodePositions`/`nodeActions` whose keys ARE cross-checked above).
    const terminalNodes = TerminalNodes.of(command.terminalNodes);
    // Printer configuration — same shape: pure operational config, not
    // change-gated, no post-commit side-effect. Validated pre-tx so a malformed
    // printer config (bad mode/paperWidth/cutMode enum, non-integer port,
    // network-escpos with no host) fails fast.
    const printerConfiguration = PrinterConfiguration.of(command.printerConfiguration);
    const newCategories = this.buildCategories(command.categories);
    const codeToId = new Map(newCategories.map((c) => [c.code, c.id.value]));
    const newRules = this.buildRoutingRules(command.routingRules, codeToId);
    // Edge-membership cross-check (anti-corruption): the VO deliberately does
    // NOT depend on `StateMachine` (DIP), so it cannot validate that a layout
    // key corresponds to a real transition. That check belongs here, in the use
    // case, which already built the state machine. Done pre-tx so a layout key
    // that names no edge fails fast (NFR-REL-02 — no illegal layout burns a
    // write). Keys are opaque "from->to" strings.
    const edgeKeys = new Set(stateMachine.transitions.map((r) => `${r.from}->${r.to}`));
    for (const key of edgeRoutingLayout.keys()) {
      if (!edgeKeys.has(key)) {
        throw new InvalidValueObjectException(
          `edge routing layout key '${key}' is not a transition in the active state machine`,
        );
      }
    }
    // State-membership cross-check (anti-corruption): the VO stays free of a
    // `StateMachine` dependency (DIP), so it cannot validate that a position key
    // corresponds to a real state. That check belongs here, in the use case,
    // which already built the state machine. Keys are state names, so they must
    // be ⊆ the active state-schema STATES (NOT transition edges — that's
    // `edgeRoutingLayout`'s check). Done pre-tx so a position key that names no
    // state fails fast (NFR-REL-02 — no illegal layout burns a write).
    const stateNames = new Set(stateMachine.stateSchema.states);
    for (const key of nodePositions.keys()) {
      if (!stateNames.has(key)) {
        throw new InvalidValueObjectException(
          `node positions key '${key}' is not a state in the active state machine`,
        );
      }
    }
    // State-membership + value-membership cross-check (anti-corruption): the VO
    // stays free of a `StateMachine` dependency (DIP), so it cannot validate that
    // an action-map key (or an `UPDATE_STATUS` action's `value`) corresponds to a
    // real state. That check belongs here, in the use case, which already built
    // the state machine. Keys are state names, and a `UPDATE_STATUS` action's
    // `value` is also a state name, so both must be ⊆ the active state-schema
    // STATES. Done pre-tx so an illegal action map fails fast (NFR-REL-02 — no
    // illegal action map burns a write). Mirrors the `nodePositions` cross-check.
    for (const key of nodeActions.keys()) {
      if (!stateNames.has(key)) {
        throw new InvalidValueObjectException(
          `node actions key '${key}' is not a state in the active state machine`,
        );
      }
      for (const action of nodeActions.actionsFor(key)) {
        if (action.type === 'UPDATE_STATUS' && !stateNames.has(action.value)) {
          throw new InvalidValueObjectException(
            `node actions['${key}'].value '${action.value}' is not a state in the active state machine`,
          );
        }
      }
    }
    // State-membership cross-check (anti-corruption): the VO stays free of a
    // `StateMachine` dependency (DIP), so it cannot validate that a description
    // key corresponds to a real state. That check belongs here, in the use
    // case, which already built the state machine. Keys are state names, so
    // they must be ⊆ the active state-schema STATES. Done pre-tx so a
    // description key that names no state fails fast (NFR-REL-02 — no illegal
    // description map burns a write). Mirrors the `nodePositions`/
    // `nodeActions` cross-checks.
    for (const key of stateMachine.stateDescriptions.keys()) {
      if (!stateNames.has(key)) {
        throw new InvalidValueObjectException(
          `state descriptions key '${key}' is not a state in the active state machine`,
        );
      }
    }

    // Whether the daily-reset policy changed (or this is the initial setup).
    // Hoisted out of the tx so the post-commit re-arm (below) can read it
    // without re-reading the config. Default `true` covers the initial-setup
    // case (oldConfig null → policy goes from nonexistent to set, must arm).
    let dailyResetPolicyChanged = true;

    // 2. Persist everything in one tx. The pre-mutation reads (for the audit
    //    before-snapshots and for preserving the singleton id + setup flag) are
    //    done INSIDE the transaction so they observe the same DB state being
    //    mutated — a concurrent writer cannot interleave between the snapshot
    //    read and the write (NFR-REL-02 / NFR-SEC-02).
    const result = await this.txManager.runInTransaction(async () => {
      // Capture pre-mutation state for audit before-snapshots + id preservation.
      const oldConfig = await this.config.get();
      const oldPolicy = oldConfig ? oldConfig.dailyResetPolicy : null;
      // Structural equality over the four policy props (mode, cron, resetTo,
      // archive). This is *structural*, not *operational*: e.g. a MANUAL→MANUAL
      // save whose persisted cron string differs would count as a change even
      // though no cron is armed either way. In practice the admin/wizard client
      // nulls the cron field on MANUAL mode (QUE-16 finalize), so a stale cron
      // only reaches here via a direct API call — acceptable, and the audit
      // before/after snapshot accurately reflects the stored VO either way.
      dailyResetPolicyChanged = oldPolicy ? !oldPolicy.equals(dailyResetPolicy) : true;
      const oldStateMachine: StateMachineDto | null = oldConfig
        ? projectStateMachine(oldConfig.stateMachine)
        : null;
      const oldCategorySnapshots = (await this.categories.getAll()).map(categorySnapshot);
      const oldRoutingSnapshots = (await this.routingRules.getAll()).map(routingSnapshot);

      // Reconstitute the singleton config with the new values, preserving the
      // existing id (or minting one on first run) and the setup flag.
      const id = oldConfig ? oldConfig.id : Identifier.generate();
      const wasCompleted = oldConfig ? oldConfig.isInitialSetupCompleted : false;
      const system = SystemConfiguration.reconstitute({
        id,
        storeName: command.storeName,
        isInitialSetupCompleted: wasCompleted,
        stateMachine,
        dailyResetPolicy,
        brandColor,
        serviceThemes,
        tvPanelLayout,
        edgeRoutingLayout,
        nodePositions,
        nodeActions,
        terminalNodes,
        printerConfiguration,
      });
      system.completeInitialSetup(); // idempotent — validates store name, flips the flag

      // Persist: fully replace categories + routings, upsert the singleton config.
      await this.categories.deleteAll();
      for (const category of newCategories) {
        await this.categories.save(category);
      }
      await this.routingRules.deleteAll();
      for (const rule of newRules) {
        await this.routingRules.save(rule);
      }
      await this.config.save(system);

      if (this.recordAudit) {
        await this.recordAudit.execute({
          actor: command.actor,
          action: AuditAction.STATE_SCHEMA_CHANGE,
          before: oldStateMachine === null ? null : toSnapshot(oldStateMachine),
          after: toSnapshot(projectStateMachine(stateMachine)),
        });
        await this.recordAudit.execute({
          actor: command.actor,
          action: AuditAction.ROUTING_CHANGE,
          before: { categories: oldCategorySnapshots, routingRules: oldRoutingSnapshots },
          after: {
            categories: newCategories.map(categorySnapshot),
            routingRules: newRules.map(routingSnapshot),
          },
        });
        // QUE-32: a policy-only edit has its own audit action — recorded ONLY
        // when the daily-reset policy actually changed (unlike the two entries
        // above, which are recorded on every save). On initial setup `oldPolicy`
        // is null and the before-snapshot is null.
        if (dailyResetPolicyChanged) {
          await this.recordAudit.execute({
            actor: command.actor,
            action: AuditAction.DAILY_RESET_POLICY_CHANGE,
            before: oldPolicy ? toSnapshot(dailyResetPolicySnapshot(oldPolicy)) : null,
            after: toSnapshot(dailyResetPolicySnapshot(dailyResetPolicy)),
          });
        }
      }

      return {
        isInitialSetupCompleted: system.isInitialSetupCompleted,
        storeName: system.storeName,
        brandColor: system.brandColor.value,
        serviceThemes: system.serviceThemes.toDto(),
        tvPanelLayout: system.tvPanelLayout.toDto(),
        edgeRoutingLayout: system.edgeRoutingLayout.toDto(),
        nodePositions: system.nodePositions.toDto(),
        nodeActions: system.nodeActions.toDto(),
        terminalNodes: system.terminalNodes.toDto(),
        printerConfiguration: system.printerConfiguration.toDto(),
      };
    });

    // 3. Post-commit: re-arm the daily-reset cron when the policy changed (or
    //    this was the initial setup) so the edit takes effect without a restart
    //    (QUE-32 / FR-ADM-01). Post-commit by design — a rolled-back save (the
    //    tx above would have thrown) never reaches here, so the scheduler is
    //    never re-armed to an un-persisted policy (NFR-REL-02). `scheduler` is
    //    null in unit tests that don't care about the cron.
    if (this.scheduler && dailyResetPolicyChanged) {
      await this.scheduler.reArm();
    }

    // 4. Post-commit: broadcast SYSTEM_CONFIG_CHANGED so connected caller
    //    panels refetch the active state machine and reflect the admin-designed
    //    flow + its `actionLabel` wording without a page reload (FR-CLR-02).
    //    Post-commit for the same reason as the scheduler re-arm — a rolled-back
    //    save never announces an un-persisted configuration (NFR-REL-02). The
    //    event is a pure refetch signal; `dispatcher` is null in unit tests.
    if (this.dispatcher) {
      await this.dispatcher.dispatchEvents([new SystemConfigurationChangedEvent()]);
    }

    return result;
  }

  private buildStateMachine(dto: WizardStateMachineDto): StateMachine {
    const schema = StateSchema.of([...dto.states]);
    const rules = dto.transitions.map((t) => StateTransitionRule.of(t.from, t.to, t.actionLabel));
    // Per-state editable descriptions (intrinsic per-state metadata, part of the
    // state-machine definition). `StateDescriptions.of` is permissive on a
    // missing `descriptions` key (backward-compat with direct API calls / tests
    // that omit it → empty default = derive from canonical copy). The state-
    // membership cross-check (every key ⊆ the active state schema) runs below
    // in `execute`, mirroring `nodePositions`/`nodeActions` (DIP — the VO stays
    // free of a `StateMachine` dependency).
    const descriptions = StateDescriptions.of(dto.descriptions ?? undefined);
    return new StateMachine(schema, rules, descriptions);
  }

  private buildCategories(dtos: readonly WizardCategoryDto[]): Category[] {
    const built: Category[] = [];
    const seenCodes = new Set<string>();
    for (const dto of dtos) {
      if (seenCodes.has(dto.code)) {
        throw new InvalidValueObjectException(`duplicate category code '${dto.code}'`);
      }
      seenCodes.add(dto.code);
      const id = dto.id ? Identifier.of(dto.id) : Identifier.generate();
      built.push(new Category(id, dto.code, dto.name));
    }
    return built;
  }

  private buildRoutingRules(
    dtos: readonly WizardRoutingRuleDto[],
    codeToId: Map<string, string>,
  ): CounterRoutingRule[] {
    const built: CounterRoutingRule[] = [];
    const seenCounterIds = new Set<number>();
    for (const dto of dtos) {
      if (seenCounterIds.has(dto.counterId)) {
        throw new InvalidValueObjectException(`duplicate counter id ${dto.counterId}`);
      }
      seenCounterIds.add(dto.counterId);
      const assignedCategoryIds = dto.assignedCategoryCodes.map((code) => {
        const id = codeToId.get(code);
        if (!id) {
          throw new InvalidValueObjectException(
            `routing rule for counter ${dto.counterId} references unknown category code '${code}'`,
          );
        }
        return id;
      });
      built.push(
        CounterRoutingRule.create(
          Identifier.generate(),
          dto.counterId,
          dto.counterName,
          assignedCategoryIds,
          dto.priorityPolicy,
        ),
      );
    }
    return built;
  }
}