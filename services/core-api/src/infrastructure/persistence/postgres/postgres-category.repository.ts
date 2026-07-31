import type { Pool } from 'pg';
import { type ICategoryRepository, Category } from '../../../domain/queue';
import { Identifier } from '../../../domain/shared';
import { withDbClient } from './transaction-context';

interface CategoryRow {
  id: string;
  code: string;
  name: string;
}

/** PostgreSQL implementation of {@link ICategoryRepository} (QUE-30). */
export class PostgresCategoryRepository implements ICategoryRepository {
  constructor(private readonly pool: Pool) {}

  async getAll(): Promise<Category[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<CategoryRow>('SELECT * FROM categories');
      return rows.map(toCategory);
    });
  }

  async getById(id: string): Promise<Category | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<CategoryRow>('SELECT * FROM categories WHERE id = $1', [
        id,
      ]);
      return rows.length ? toCategory(rows[0]) : null;
    });
  }

  async getByCode(code: string): Promise<Category | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<CategoryRow>(
        'SELECT * FROM categories WHERE code = $1',
        [code],
      );
      return rows.length ? toCategory(rows[0]) : null;
    });
  }

  async save(category: Category): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO categories (id, code, name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name`,
        [category.id.value, category.code, category.name],
      );
    });
  }
}

function toCategory(row: CategoryRow): Category {
  return new Category(Identifier.of(row.id), row.code, row.name);
}