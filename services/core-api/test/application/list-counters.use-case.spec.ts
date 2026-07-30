import { Identifier } from '../../src/domain/shared';
import { PriorityPolicy } from '../../src/domain/shared/priority-policy';
import { CounterRoutingRule } from '../../src/domain/store-config';
import { Category } from '../../src/domain/queue';
import { ListCountersUseCase } from '../../src/application/store-config';
import {
  InMemoryCategoryRepository,
  InMemoryCounterRoutingRuleRepository,
} from '../../src/infrastructure/persistence/in-memory';

/** A category with a fresh UUID id. */
function category(code: string, name: string): Category {
  return new Category(Identifier.generate(), code, name);
}

/** A routing rule for `counterId` serving `categoryIds` under `policy`. */
function rule(
  counterId: number,
  categoryIds: readonly string[],
  policy: PriorityPolicy = PriorityPolicy.FIFO_GLOBAL,
): CounterRoutingRule {
  return CounterRoutingRule.create(
    Identifier.generate(),
    counterId,
    `Counter ${counterId}`,
    categoryIds,
    policy,
  );
}

describe('ListCountersUseCase (caller counter selection — FR-CLR-01)', () => {
  let categories: InMemoryCategoryRepository;
  let routingRules: InMemoryCounterRoutingRuleRepository;
  let useCase: ListCountersUseCase;

  beforeEach(() => {
    categories = new InMemoryCategoryRepository();
    routingRules = new InMemoryCounterRoutingRuleRepository();
    useCase = new ListCountersUseCase(routingRules, categories);
  });

  it('returns an empty list when no counters are configured', async () => {
    expect(await useCase.execute()).toEqual([]);
  });

  it('projects each counter with its assigned categories joined to master data', async () => {
    const catA = category('A', 'Customer Service');
    const catB = category('B', 'Kasir & Pembayaran');
    await categories.save(catA);
    await categories.save(catB);
    await routingRules.save(rule(2, [catB.id.value, catA.id.value], PriorityPolicy.CATEGORY_PRIORITY));
    await routingRules.save(rule(1, [catA.id.value], PriorityPolicy.FIFO_GLOBAL));

    const result = await useCase.execute();

    // Sorted by counterId ascending.
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      counterId: 1,
      counterName: 'Counter 1',
      assignedCategories: [{ id: catA.id.value, code: 'A', name: 'Customer Service' }],
      priorityPolicy: PriorityPolicy.FIFO_GLOBAL,
    });
    expect(result[1]).toEqual({
      counterId: 2,
      counterName: 'Counter 2',
      assignedCategories: [
        { id: catB.id.value, code: 'B', name: 'Kasir & Pembayaran' },
        { id: catA.id.value, code: 'A', name: 'Customer Service' },
      ],
      priorityPolicy: PriorityPolicy.CATEGORY_PRIORITY,
    });
  });

  it('skips an assigned category id that has no matching master data (graceful degradation)', async () => {
    const catA = category('A', 'Customer Service');
    await categories.save(catA);
    // CAT-stale has no Category row.
    await routingRules.save(rule(1, [catA.id.value, 'CAT-stale']));

    const [counter] = await useCase.execute();
    expect(counter.assignedCategories).toEqual([
      { id: catA.id.value, code: 'A', name: 'Customer Service' },
    ]);
  });
});