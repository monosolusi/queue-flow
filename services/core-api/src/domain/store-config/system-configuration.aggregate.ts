import { AggregateRoot } from '../shared/aggregate-root';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';
import { BrandColor } from './value-objects/brand-color';
import { DailyResetPolicy } from './value-objects/daily-reset-policy';
import { EdgeRoutingLayout } from './value-objects/edge-routing-layout';
import { NodeActions } from './value-objects/node-actions';
import { NodePositions } from './value-objects/node-positions';
import { PrinterConfiguration } from './value-objects/printer-configuration';
import { ServiceThemes } from './value-objects/service-themes';
import { TvPanelLayout } from './value-objects/tv-panel-layout';
import { StateMachine } from './state-machine';

/**
 * Aggregate root for the store's system configuration (PRD §4.1.A). Owns the
 * initial-setup flag, store profile, active state machine, and daily reset
 * policy. Mutated by the first-run wizard (QUE-1) and the admin config module
 * (QUE-24); every change is audit-logged (NFR-SEC-02).
 */
export class SystemConfiguration extends AggregateRoot {
  private _storeName: string;
  private _isInitialSetupCompleted: boolean;
  private readonly _stateMachine: StateMachine;
  private _dailyResetPolicy: DailyResetPolicy;
  private _brandColor: BrandColor;
  private _serviceThemes: ServiceThemes;
  private _tvPanelLayout: TvPanelLayout;
  private _edgeRoutingLayout: EdgeRoutingLayout;
  private _nodePositions: NodePositions;
  private _nodeActions: NodeActions;
  private _printerConfiguration: PrinterConfiguration;

  private constructor(
    id: Identifier,
    storeName: string,
    isInitialSetupCompleted: boolean,
    stateMachine: StateMachine,
    dailyResetPolicy: DailyResetPolicy,
    brandColor: BrandColor,
    serviceThemes: ServiceThemes,
    tvPanelLayout: TvPanelLayout,
    edgeRoutingLayout: EdgeRoutingLayout,
    nodePositions: NodePositions,
    nodeActions: NodeActions,
    printerConfiguration: PrinterConfiguration,
  ) {
    super(id);
    this._storeName = storeName;
    this._isInitialSetupCompleted = isInitialSetupCompleted;
    this._stateMachine = stateMachine;
    this._dailyResetPolicy = dailyResetPolicy;
    this._brandColor = brandColor;
    this._serviceThemes = serviceThemes;
    this._tvPanelLayout = tvPanelLayout;
    this._edgeRoutingLayout = edgeRoutingLayout;
    this._nodePositions = nodePositions;
    this._nodeActions = nodeActions;
    this._printerConfiguration = printerConfiguration;
  }

  /** Creates a fresh, not-yet-configured instance with the default state machine,
   * brand color, service themes, TV panel layout, edge routing layout, node
   * positions, and printer configuration. `brandColor` + `serviceThemes` +
   * `tvPanelLayout` + `edgeRoutingLayout` + `nodePositions` + `nodeActions` +
   * `printerConfiguration` default so the dev seed and acceptance `seedPrdConfig`
   * (2-arg calls) need no change. */
  public static create(
    id: Identifier,
    storeName = '',
    brandColor: BrandColor = BrandColor.DEFAULT,
    serviceThemes: ServiceThemes = ServiceThemes.DEFAULT,
    tvPanelLayout: TvPanelLayout = TvPanelLayout.DEFAULT,
    edgeRoutingLayout: EdgeRoutingLayout = EdgeRoutingLayout.DEFAULT,
    nodePositions: NodePositions = NodePositions.DEFAULT,
    nodeActions: NodeActions = NodeActions.DEFAULT,
    printerConfiguration: PrinterConfiguration = PrinterConfiguration.DEFAULT,
  ): SystemConfiguration {
    return new SystemConfiguration(
      id,
      storeName,
      false,
      StateMachine.DEFAULT,
      DailyResetPolicy.DEFAULT,
      brandColor,
      serviceThemes,
      tvPanelLayout,
      edgeRoutingLayout,
      nodePositions,
      nodeActions,
      printerConfiguration,
    );
  }

  public static reconstitute(params: {
    id: Identifier;
    storeName: string;
    isInitialSetupCompleted: boolean;
    stateMachine: StateMachine;
    dailyResetPolicy: DailyResetPolicy;
    brandColor: BrandColor;
    serviceThemes: ServiceThemes;
    tvPanelLayout: TvPanelLayout;
    edgeRoutingLayout: EdgeRoutingLayout;
    nodePositions: NodePositions;
    nodeActions: NodeActions;
    printerConfiguration: PrinterConfiguration;
  }): SystemConfiguration {
    return new SystemConfiguration(
      params.id,
      params.storeName,
      params.isInitialSetupCompleted,
      params.stateMachine,
      params.dailyResetPolicy,
      params.brandColor,
      params.serviceThemes,
      params.tvPanelLayout,
      params.edgeRoutingLayout,
      params.nodePositions,
      params.nodeActions,
      params.printerConfiguration,
    );
  }

  public get storeName(): string {
    return this._storeName;
  }

  public get isInitialSetupCompleted(): boolean {
    return this._isInitialSetupCompleted;
  }

  public get stateMachine(): StateMachine {
    return this._stateMachine;
  }

  public get dailyResetPolicy(): DailyResetPolicy {
    return this._dailyResetPolicy;
  }

  public get brandColor(): BrandColor {
    return this._brandColor;
  }

  public get serviceThemes(): ServiceThemes {
    return this._serviceThemes;
  }

  public get tvPanelLayout(): TvPanelLayout {
    return this._tvPanelLayout;
  }

  public get edgeRoutingLayout(): EdgeRoutingLayout {
    return this._edgeRoutingLayout;
  }

  public get nodePositions(): NodePositions {
    return this._nodePositions;
  }

  public get nodeActions(): NodeActions {
    return this._nodeActions;
  }

  public get printerConfiguration(): PrinterConfiguration {
    return this._printerConfiguration;
  }

  public setStoreName(name: string): void {
    if (!name || !name.trim()) {
      throw new InvalidValueObjectException('store name must not be empty');
    }
    this._storeName = name;
  }

  public setDailyResetPolicy(policy: DailyResetPolicy): void {
    this._dailyResetPolicy = policy;
  }

  /** Finalizes the wizard — flips the setup flag and unlocks normal operations. */
  public completeInitialSetup(): void {
    if (!this._storeName.trim()) {
      throw new InvalidValueObjectException('cannot complete setup without a store name');
    }
    this._isInitialSetupCompleted = true;
  }
}