import type { ISystemConfigurationRepository } from '../../domain/store-config';
import type { ICounterRoutingRuleRepository } from '../../domain/store-config';
import type { ICategoryRepository } from '../../domain/queue';
import { Category } from '../../domain/queue';
import { CounterRoutingRule } from '../../domain/store-config';
import { SystemConfiguration } from '../../domain/store-config';
import { StateMachine } from '../../domain/store-config';
import { StateSchema } from '../../domain/store-config';
import { StateTransitionRule } from '../../domain/store-config';
import { DailyResetPolicy, DailyResetMode } from '../../domain/store-config';
import { type IDailyResetSchedulerPort } from '../../domain/store-config';
import {
  Identifier,
  InvalidValueObjectException,
  type ITransactionManager,
  NoOpTransactionManager,
  type PriorityPolicy,
} from '../../domain/shared';
import { AuditAction, toSnapshot } from '../../domain/audit';
import { type RecordAuditEntryUseCase } from '../audit/record-audit-entry.use-case';
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
}

export interface WizardDailyResetDto {
  readonly mode: DailyResetMode;
  readonly cronExpression: string | null;
  readonly resetTicketNumberTo: number;
  readonly archivePreviousDayData: boolean;
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
  readonly actor: string;
}

export interface SaveSystemConfigurationResult {
  readonly isInitialSetupCompleted: boolean;
  readonly storeName: string;
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
} {
  return {
    mode: p.mode,
    cronExpression: p.cronExpression,
    resetTicketNumberTo: p.resetTicketNumberTo,
    archivePreviousDayData: p.archivePreviousDayData,
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
 * `recordAudit`, `txManager`, and `scheduler` are optional with no-op/null
 * defaults, so unit tests can construct the use case directly with just the
 * three repository ports. Depends only on ports + the application-layer audit
 * seam (DIP): no ORM, HTTP framework, or I/O library (NFR-MNT-01). The
 * controller is the anti-corruption translation point that turns the HTTP
 * wizard payload into this command.
 */
export class SaveSystemConfigurationUseCase {
  constructor(
    private readonly config: ISystemConfigurationRepository,
    private readonly categories: ICategoryRepository,
    private readonly routingRules: ICounterRoutingRuleRepository,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
    private readonly scheduler: IDailyResetSchedulerPort | null = null,
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
    );
    const newCategories = this.buildCategories(command.categories);
    const codeToId = new Map(newCategories.map((c) => [c.code, c.id.value]));
    const newRules = this.buildRoutingRules(command.routingRules, codeToId);

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

    return result;
  }

  private buildStateMachine(dto: WizardStateMachineDto): StateMachine {
    const schema = StateSchema.of([...dto.states]);
    const rules = dto.transitions.map((t) => StateTransitionRule.of(t.from, t.to, t.actionLabel));
    return new StateMachine(schema, rules);
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