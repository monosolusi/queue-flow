import type { Category } from '../entities/category';

/** Repository abstraction for {@link Category} master data. */
export interface ICategoryRepository {
  getAll(): Promise<Category[]>;
  getById(id: string): Promise<Category | null>;
  getByCode(code: string): Promise<Category | null>;
  save(category: Category): Promise<void>;
}