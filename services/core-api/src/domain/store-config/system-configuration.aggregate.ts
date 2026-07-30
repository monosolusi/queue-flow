import { AggregateRoot } from '../shared/aggregate-root';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';
import { DailyResetPolicy } from './value-objects/daily-reset-policy';
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

  private constructor(
    id: Identifier,
    storeName: string,
    isInitialSetupCompleted: boolean,
    stateMachine: StateMachine,
    dailyResetPolicy: DailyResetPolicy,
  ) {
    super(id);
    this._storeName = storeName;
    this._isInitialSetupCompleted = isInitialSetupCompleted;
    this._stateMachine = stateMachine;
    this._dailyResetPolicy = dailyResetPolicy;
  }

  /** Creates a fresh, not-yet-configured instance with the default state machine. */
  public static create(id: Identifier, storeName = ''): SystemConfiguration {
    return new SystemConfiguration(
      id,
      storeName,
      false,
      StateMachine.DEFAULT,
      DailyResetPolicy.DEFAULT,
    );
  }

  public static reconstitute(params: {
    id: Identifier;
    storeName: string;
    isInitialSetupCompleted: boolean;
    stateMachine: StateMachine;
    dailyResetPolicy: DailyResetPolicy;
  }): SystemConfiguration {
    return new SystemConfiguration(
      params.id,
      params.storeName,
      params.isInitialSetupCompleted,
      params.stateMachine,
      params.dailyResetPolicy,
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