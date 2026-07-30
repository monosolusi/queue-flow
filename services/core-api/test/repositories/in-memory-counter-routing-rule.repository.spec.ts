import { Identifier } from '../../src/domain/shared';
import {
  CounterRoutingRule,
  PriorityPolicy,
} from '../../src/domain/store-config';
import { InMemoryCounterRoutingRuleRepository } from '../../src/infrastructure/persistence/in-memory';

function rule(counterId: number, categories: string[]): CounterRoutingRule {
  return CounterRoutingRule.create(
    Identifier.generate(),
    counterId,
    `Counter ${counterId}`,
    categories,
    PriorityPolicy.FIFO_GLOBAL,
  );
}

describe('InMemoryCounterRoutingRuleRepository', () => {
  it('save + getByCounterId round-trip', async () => {
    const repo = new InMemoryCounterRoutingRuleRepository();
    await repo.save(rule(1, ['CAT-A']));
    const found = await repo.getByCounterId(1);
    expect(found).not.toBeNull();
    expect(found?.assignedCategoryIds).toEqual(['CAT-A']);
  });

  it('getByCounterId returns null for unknown counter', async () => {
    const repo = new InMemoryCounterRoutingRuleRepository();
    expect(await repo.getByCounterId(99)).toBeNull();
  });

  it('getAll returns every saved rule', async () => {
    const repo = new InMemoryCounterRoutingRuleRepository();
    await repo.save(rule(1, ['CAT-A']));
    await repo.save(rule(2, ['CAT-A', 'CAT-B']));
    expect((await repo.getAll()).map((r) => r.counterId).sort()).toEqual([1, 2]);
  });
});