import type { CounterRoutingRule } from '../counter-routing-rule.aggregate';

/** Repository abstraction for {@link CounterRoutingRule} aggregates. */
export interface ICounterRoutingRuleRepository {
  getByCounterId(counterId: number): Promise<CounterRoutingRule | null>;
  getAll(): Promise<CounterRoutingRule[]>;
  save(rule: CounterRoutingRule): Promise<void>;
}