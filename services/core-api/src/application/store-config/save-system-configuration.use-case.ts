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
 * The wizard / admin save (FR-WZD-02..06). Validates and persists the full
 * system configuration in **one** {@link ITransactionManager.runInTransaction}
 * block: the categories and routing rules are fully replaced (deleteAll + save
 * each), the singleton `SystemConfiguration` is reconstituted with the new state
 * machine + daily-reset policy + store name, and `completeInitialSetup()` flips
 * the setup flag (idempotent on re-edit). Two audit entries are appended inside
 * the same tx — `STATE_SCHEMA_CHANGE` (state-machine before/after) and
 * `ROUTING_CHANGE` (categories + routings before/after) — so a power cut leaves
 * either the whole configuration committed or nothing (NFR-REL-02 / NFR-SEC-02).
 *
 * `recordAudit` and `txManager` are optional with no-op defaults, so unit tests
 * can construct the use case directly with just the three repository ports.
 * Depends only on ports + the application-layer audit seam (DIP): no ORM, HTTP
 * framework, or I/O library (NFR-MNT-01). The controller is the anti-corruption
 * translation point that turns the HTTP wizard payload into this command.
 */
export class SaveSystemConfigurationUseCase {
  constructor(
    private readonly config: ISystemConfigurationRepository,
    private readonly categories: ICategoryRepository,
    private readonly routingRules: ICounterRoutingRuleRepository,
    private readonly txManager: ITransactionManager = new NoOpTransactionManager(),
    private readonly recordAudit: RecordAuditEntryUseCase | null = null,
  ) {}

  public async execute(
    command: SaveSystemConfigurationCommand,
  ): Promise<SaveSystemConfigurationResult> {
    // 1. Build + validate the domain objects (throws InvalidValueObjectException
    //    on bad input — the controller maps that to 400).
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

    // 2. Capture the pre-mutation state for audit before-snapshots.
    const oldConfig = await this.config.get();
    const oldStateMachine: StateMachineDto | null = oldConfig
      ? projectStateMachine(oldConfig.stateMachine)
      : null;
    const oldCategorySnapshots = (await this.categories.getAll()).map(categorySnapshot);
    const oldRoutingSnapshots = (await this.routingRules.getAll()).map(routingSnapshot);

    // 3. Reconstitute the singleton config with the new values, preserving the
    //    existing id (or minting one on first run) and the setup flag.
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

    // 4. Persist everything in one tx; append audit inside the same tx.
    await this.txManager.runInTransaction(async () => {
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
      }
    });

    return { isInitialSetupCompleted: system.isInitialSetupCompleted, storeName: system.storeName };
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