import { Category, ICategoryRepository } from '../../../domain/queue';

/** In-memory implementation of {@link ICategoryRepository} for tests/dev. */
export class InMemoryCategoryRepository implements ICategoryRepository {
  private readonly byId = new Map<string, Category>();

  async getAll(): Promise<Category[]> {
    return [...this.byId.values()];
  }

  async getById(id: string): Promise<Category | null> {
    return this.byId.get(id) ?? null;
  }

  async getByCode(code: string): Promise<Category | null> {
    return [...this.byId.values()].find((c) => c.code === code) ?? null;
  }

  async save(category: Category): Promise<void> {
    this.byId.set(category.id.value, category);
  }
}