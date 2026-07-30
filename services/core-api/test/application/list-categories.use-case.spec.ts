import { Identifier } from '../../src/domain/shared';
import { Category } from '../../src/domain/queue';
import { ListCategoriesUseCase } from '../../src/application/queue';
import { InMemoryCategoryRepository } from '../../src/infrastructure/persistence/in-memory';

/** A category with a fresh UUID id. */
function category(code: string, name: string): Category {
  return new Category(Identifier.generate(), code, name);
}

describe('ListCategoriesUseCase (kiosk category selection — FR-KSK-01 / QUE-17)', () => {
  let categories: InMemoryCategoryRepository;
  let useCase: ListCategoriesUseCase;

  beforeEach(() => {
    categories = new InMemoryCategoryRepository();
    useCase = new ListCategoriesUseCase(categories);
  });

  it('returns an empty list when no categories are configured', async () => {
    expect(await useCase.execute()).toEqual([]);
  });

  it('projects each category to the kiosk read DTO (id, code, name)', async () => {
    const catA = category('A', 'Customer Service');
    const catB = category('B', 'Kasir & Pembayaran');
    await categories.save(catA);
    await categories.save(catB);

    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { id: catA.id.value, code: 'A', name: 'Customer Service' },
      { id: catB.id.value, code: 'B', name: 'Kasir & Pembayaran' },
    ]);
  });

  it('orders categories by code so the kiosk layout is stable across renders', async () => {
    // Saved out of code order to prove the use case sorts, not the repository.
    const catC = category('C', 'Loket 3');
    const catA = category('A', 'Loket 1');
    const catB = category('B', 'Loket 2');
    await categories.save(catC);
    await categories.save(catA);
    await categories.save(catB);

    const result = await useCase.execute();

    expect(result.map((c) => c.code)).toEqual(['A', 'B', 'C']);
  });
});