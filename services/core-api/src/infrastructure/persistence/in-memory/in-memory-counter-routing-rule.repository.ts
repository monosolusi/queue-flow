import {
  CounterRoutingRule,
  ICounterRoutingRuleRepository,
} from '../../../domain/store-config';

/** In-memory implementation of {@link ICounterRoutingRuleRepository} for tests/dev. */
export class InMemoryCounterRoutingRuleRepository implements ICounterRoutingRuleRepository {
  private readonly byCounterId = new Map<number, CounterRoutingRule>();

  async getByCounterId(counterId: number): Promise<CounterRoutingRule | null> {
    return this.byCounterId.get(counterId) ?? null;
  }

  async getAll(): Promise<CounterRoutingRule[]> {
    return [...this.byCounterId.values()];
  }

  async save(rule: CounterRoutingRule): Promise<void> {
    this.byCounterId.set(rule.counterId, rule);
  }

  async deleteAll(): Promise<void> {
    this.byCounterId.clear();
  }

  /** Test/dev-only: drops all stored routing rules. Not on the port interface. */
  clear(): void {
    this.byCounterId.clear();
  }
}