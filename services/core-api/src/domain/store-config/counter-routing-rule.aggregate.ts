import { AggregateRoot } from '../shared/aggregate-root';
import { Identifier } from '../shared/identifier';
import { InvalidValueObjectException } from '../shared/errors';
import { PriorityPolicy } from './value-objects/priority-policy';

/**
 * Aggregate root for one counter's routing rule: which categories it serves and
 * the order in which it picks the next ticket (PRD §4.1.C / FR-ENG-03).
 */
export class CounterRoutingRule extends AggregateRoot {
  private _counterId: number;
  private _counterName: string;
  private _assignedCategoryIds: readonly string[];
  private _priorityPolicy: PriorityPolicy;

  private constructor(
    id: Identifier,
    counterId: number,
    counterName: string,
    assignedCategoryIds: readonly string[],
    priorityPolicy: PriorityPolicy,
  ) {
    super(id);
    this._counterId = counterId;
    this._counterName = counterName;
    this._assignedCategoryIds = assignedCategoryIds;
    this._priorityPolicy = priorityPolicy;
  }

  public static create(
    id: Identifier,
    counterId: number,
    counterName: string,
    assignedCategoryIds: readonly string[],
    priorityPolicy: PriorityPolicy = PriorityPolicy.FIFO_GLOBAL,
  ): CounterRoutingRule {
    return new CounterRoutingRule(
      id,
      counterId,
      counterName,
      CounterRoutingRule.normalize(assignedCategoryIds),
      priorityPolicy,
    );
  }

  public static reconstitute(params: {
    id: Identifier;
    counterId: number;
    counterName: string;
    assignedCategoryIds: readonly string[];
    priorityPolicy: PriorityPolicy;
  }): CounterRoutingRule {
    return new CounterRoutingRule(
      params.id,
      params.counterId,
      params.counterName,
      params.assignedCategoryIds,
      params.priorityPolicy,
    );
  }

  private static normalize(ids: readonly string[]): readonly string[] {
    if (!ids.length) {
      throw new InvalidValueObjectException(
        'a counter routing rule must assign at least one category',
      );
    }
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || !id.trim()) {
        throw new InvalidValueObjectException('category id must not be empty');
      }
      if (seen.has(id)) {
        throw new InvalidValueObjectException(`duplicate assigned category '${id}'`);
      }
      seen.add(id);
    }
    return ids;
  }

  public get counterId(): number {
    return this._counterId;
  }

  public get counterName(): string {
    return this._counterName;
  }

  public get assignedCategoryIds(): readonly string[] {
    return this._assignedCategoryIds;
  }

  public get priorityPolicy(): PriorityPolicy {
    return this._priorityPolicy;
  }

  public servesCategory(categoryId: string): boolean {
    return this._assignedCategoryIds.includes(categoryId);
  }
}