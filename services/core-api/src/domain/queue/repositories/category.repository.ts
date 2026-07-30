import type { Category } from '../entities/category';

/**
 * NestJS DI token for {@link ICategoryRepository}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather
 * than by type metadata. A plain language builtin — no framework import — so
 * it does not compromise domain purity (NFR-MNT-01).
 */
export const CATEGORY_REPOSITORY = Symbol('CATEGORY_REPOSITORY');

/** Repository abstraction for {@link Category} master data. */
export interface ICategoryRepository {
  getAll(): Promise<Category[]>;
  getById(id: string): Promise<Category | null>;
  getByCode(code: string): Promise<Category | null>;
  save(category: Category): Promise<void>;
}