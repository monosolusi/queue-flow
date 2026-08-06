import type { Pool } from 'pg';
import {
  type IUserRepository,
  type Role,
  type UserSummary,
  User,
} from '../../../domain/identity';
import { withDbClient } from './transaction-context';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
}

/**
 * PostgreSQL {@link IUserRepository} (QUE-43). `save` is an upsert
 * (create-or-update by id) so `SetupInitialAdminUseCase` can re-run idempotently
 * on a partial first-run. Reads reconstitute the {@link User} aggregate from the
 * row via the trusted `reconstitute` path (no re-validation). Enlists on the
 * ambient transaction client via {@link withDbClient} when one is active.
 */
export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly pool: Pool) {}

  public async findByUsername(username: string): Promise<User | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<UserRow>(
        'SELECT id, username, password_hash, role, created_at, updated_at FROM users WHERE username = $1',
        [username],
      );
      return rows[0] ? toUser(rows[0]) : null;
    });
  }

  public async findById(id: string): Promise<User | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<UserRow>(
        'SELECT id, username, password_hash, role, created_at, updated_at FROM users WHERE id = $1',
        [id],
      );
      return rows[0] ? toUser(rows[0]) : null;
    });
  }

  public async save(user: User): Promise<void> {
    const s = user.toSnapshot();
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           username      = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           role          = EXCLUDED.role,
           updated_at    = EXCLUDED.updated_at`,
        [s.id, s.username, s.passwordHash, s.role, s.createdAt, s.updatedAt],
      );
    });
  }

  public async deleteById(id: string): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query('DELETE FROM users WHERE id = $1', [id]);
    });
  }

  public async list(): Promise<UserSummary[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<UserRow>(
        'SELECT id, username, role, created_at FROM users ORDER BY created_at ASC, username ASC',
      );
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: r.role as Role,
        createdAt: Number(r.created_at),
      }));
    });
  }

  public async countByRole(role: Role): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<{ count: string }>(
        'SELECT COUNT(*)::int AS count FROM users WHERE role = $1',
        [role],
      );
      return Number(rows[0].count);
    });
  }
}

function toUser(row: UserRow): User {
  return User.reconstitute({
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role as Role,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}