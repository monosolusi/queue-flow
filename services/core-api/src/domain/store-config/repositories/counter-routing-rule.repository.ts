import type { CounterRoutingRule } from '../counter-routing-rule.aggregate';

/**
 * NestJS DI token for {@link ICounterRoutingRuleRepository}. Interfaces are
 * erased at runtime, so the application layer injects the port by this Symbol
 * rather than by type metadata. A plain language builtin — no framework
 * import — so it does not compromise domain purity (NFR-MNT-01).
 */
export const COUNTER_ROUTING_RULE_REPOSITORY = Symbol('COUNTER_ROUTING_RULE_REPOSITORY');

/** Repository abstraction for {@link CounterRoutingRule} aggregates. */
export interface ICounterRoutingRuleRepository {
  getByCounterId(counterId: number): Promise<CounterRoutingRule | null>;
  getAll(): Promise<CounterRoutingRule[]>;
  save(rule: CounterRoutingRule): Promise<void>;
}