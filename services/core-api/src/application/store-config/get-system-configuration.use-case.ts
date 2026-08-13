import type { ISystemConfigurationRepository } from '../../domain/store-config';
import type { ICategoryRepository } from '../../domain/queue';
import type { ICounterRoutingRuleRepository } from '../../domain/store-config';
import { StateMachine } from '../../domain/store-config';
import { BrandColor } from '../../domain/store-config';
import { DailyResetPolicy, DailyResetMode } from '../../domain/store-config';
import { ServiceThemes, type ServiceThemesMap } from '../../domain/store-config';
import { TvPanelLayout, type TvGridLayout } from '../../domain/store-config';
import { EdgeRoutingLayout, type EdgeRoutingLayoutDto } from '../../domain/store-config';
import { NodePositions, type NodePositionsDto } from '../../domain/store-config';
import { NodeActions, type NodeActionsDto } from '../../domain/store-config';
import { PrinterConfiguration, type PrinterConfigurationDto } from '../../domain/store-config';
import type { PriorityPolicy } from '../../domain/shared';

/**
 * Read-side projection of the active state machine for the caller panel
 * (FR-CLR-02). A flat, transport-agnostic graph — not the `StateMachine`
 * aggregate — so the caller can render one button per outgoing edge of the
 * active ticket's status. Use cases never return the aggregate itself.
 */
export interface StateMachineDto {
  readonly states: readonly string[];
  readonly transitions: readonly {
    readonly from: string;
    readonly to: string;
    readonly actionLabel: string;
  }[];
}

/** A category projected for the config read surface. */
export interface ConfigCategoryDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A counter routing rule projected for the config read surface. */
export interface ConfigRoutingRuleDto {
  readonly counterId: number;
  readonly counterName: string;
  readonly assignedCategoryIds: readonly string[];
  readonly priorityPolicy: PriorityPolicy;
}

export interface DailyResetPolicyDto {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
  /** IANA timezone the daily-reset cron fires in (always present on the read
   *  projection — the VO defaults to the server's local TZ when unset). */
  readonly timezone: string;
}

/**
 * The full system-configuration projection returned to the admin / wizard
 * (FR-WZD-01..06). `isInitialSetupCompleted` drives the first-run redirect.
 */
export interface SystemConfigurationDto {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
  readonly stateMachine: StateMachineDto;
  readonly dailyResetPolicy: DailyResetPolicyDto;
  readonly categories: readonly ConfigCategoryDto[];
  readonly routingRules: readonly ConfigRoutingRuleDto[];
  readonly brandColor: string;
  /** Per-service light/dark theme map (QUE-47). */
  readonly serviceThemes: ServiceThemesMap;
  /** Per-widget TV grid layout (an ordered array of placed widgets). */
  readonly tvPanelLayout: TvGridLayout;
  /** Per-edge connection-point (handle) layout for the admin state-machine
   *  visual editor (sparse keyed map "from->to" -> { sourceSide, targetSide }). */
  readonly edgeRoutingLayout: EdgeRoutingLayoutDto;
  /** Per-state node x/y positions for the admin state-machine visual editor
   *  (keyed map "stateName" -> { x, y }). */
  readonly nodePositions: NodePositionsDto;
  /** Per-state Kaleo-style node-level actions for the admin state-machine editor
   *  (keyed map "stateName" -> NodeActionProps[]). Decoupled from transitions. */
  readonly nodeActions: NodeActionsDto;
  /** Printer configuration (which printer the kiosk uses — Chrome's default
   *  dialog, or a network ESC/POS printer proxied through core-api over raw
   *  TCP). */
  readonly printerConfiguration: PrinterConfigurationDto;
}

/** Projects the domain `StateMachine` into the flat {@link StateMachineDto}. */
export function projectStateMachine(sm: StateMachine): StateMachineDto {
  return {
    states: [...sm.stateSchema.states],
    transitions: sm.transitions.map((t) => ({
      from: t.from,
      to: t.to,
      actionLabel: t.actionLabel,
    })),
  };
}

/** Projects the default state machine (PRD §7) — used when no config exists yet. */
function defaultStateMachine(): StateMachineDto {
  return projectStateMachine(StateMachine.DEFAULT);
}

function defaultDailyReset(): DailyResetPolicyDto {
  const p = DailyResetPolicy.DEFAULT;
  return {
    mode: p.mode,
    cronExpression: p.cronExpression,
    resetTicketNumberTo: p.resetTicketNumberTo,
    archivePreviousDayData: p.archivePreviousDayData,
    timezone: p.timezone,
  };
}

/**
 * Read-side use case: returns the full system configuration for the admin panel
 * and the first-run wizard (FR-WZD-01). When no `SystemConfiguration` exists yet
 * (clean store), it returns a **default-shaped DTO with
 * `isInitialSetupCompleted: false`** rather than throwing — so a clean browser
 * fetching `GET /api/system/config` gets the redirect signal and the wizard can
 * prefill the PRD §7 default state machine. Depends only on ports (DIP).
 */
export class GetSystemConfigurationUseCase {
  constructor(
    private readonly config: ISystemConfigurationRepository,
    private readonly categories: ICategoryRepository,
    private readonly routingRules: ICounterRoutingRuleRepository,
  ) {}

  public async execute(): Promise<SystemConfigurationDto> {
    const system = await this.config.get();
    const [allCategories, allRules] = await Promise.all([
      this.categories.getAll(),
      this.routingRules.getAll(),
    ]);

    if (!system) {
      return {
        isInitialSetupCompleted: false,
        storeName: '',
        stateMachine: defaultStateMachine(),
        dailyResetPolicy: defaultDailyReset(),
        categories: [],
        routingRules: [],
        // The default brand color (matches the hardcoded `--accent: #2563eb`
        // across all four frontends) so a clean store prefills the wizard's
        // `<input type="color">` with the real default, not black (a color input
        // cannot represent empty). Mirrors the defaultStateMachine() /
        // defaultDailyReset() null-branch precedent.
        brandColor: BrandColor.DEFAULT.value,
        // All-light default (QUE-47) — matches the CSS `:root` light default so
        // a clean store prefills the wizard/admin theme selects with 'light'.
        serviceThemes: ServiceThemes.DEFAULT.toDto(),
        // Default TV grid layout — matches the existing TV layout so a clean
        // store prefills the admin TV-layout editor with every widget at its
        // PRD-default grid position.
        tvPanelLayout: TvPanelLayout.DEFAULT.toDto(),
        // Default edge routing layout — empty map = every edge uses the default
        // left->right routing, so a clean store prefills the admin state-machine
        // editor with no per-edge handle overrides.
        edgeRoutingLayout: EdgeRoutingLayout.DEFAULT.toDto(),
        // Default node positions — empty map = use the deterministic autoLayout,
        // so a clean store prefills the admin state-machine editor with the
        // auto-laid-out canvas (no saved positions).
        nodePositions: NodePositions.DEFAULT.toDto(),
        // Default node actions — empty map = no node-level actions, so a clean
        // store prefills the admin state-machine editor with action-less nodes
        // (Kaleo-style actions are admin-only config, decoupled from transitions).
        nodeActions: NodeActions.DEFAULT.toDto(),
        // Default printer configuration — chrome mode = zero behavior change
        // (the kiosk keeps using Chrome's print dialog), so a clean store
        // prefills the admin printer section with the existing chrome behavior.
        printerConfiguration: PrinterConfiguration.DEFAULT.toDto(),
      };
    }

    return {
      isInitialSetupCompleted: system.isInitialSetupCompleted,
      storeName: system.storeName,
      stateMachine: projectStateMachine(system.stateMachine),
      dailyResetPolicy: {
        mode: system.dailyResetPolicy.mode,
        cronExpression: system.dailyResetPolicy.cronExpression,
        resetTicketNumberTo: system.dailyResetPolicy.resetTicketNumberTo,
        archivePreviousDayData: system.dailyResetPolicy.archivePreviousDayData,
        timezone: system.dailyResetPolicy.timezone,
      },
      brandColor: system.brandColor.value,
      serviceThemes: system.serviceThemes.toDto(),
      tvPanelLayout: system.tvPanelLayout.toDto(),
      edgeRoutingLayout: system.edgeRoutingLayout.toDto(),
      nodePositions: system.nodePositions.toDto(),
      nodeActions: system.nodeActions.toDto(),
      printerConfiguration: system.printerConfiguration.toDto(),
      categories: allCategories
        .slice()
        .sort((a, b) => a.code.localeCompare(b.code))
        .map((c) => ({ id: c.id.value, code: c.code, name: c.name })),
      routingRules: allRules
        .slice()
        .sort((a, b) => a.counterId - b.counterId)
        .map((r) => ({
          counterId: r.counterId,
          counterName: r.counterName,
          assignedCategoryIds: [...r.assignedCategoryIds],
          priorityPolicy: r.priorityPolicy,
        })),
    };
  }
}