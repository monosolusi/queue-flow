import {
  type IUserRepository,
  type Role,
  type UserSummary,
  User,
} from '../../../domain/identity';

/**
 * In-memory {@link IUserRepository} for unit/integration tests and local dev
 * (LSP-interchangeable with {@link PostgresUserRepository} behind the same
 * port). `save` is an upsert by id (mirrors the Postgres `ON CONFLICT` path) so
 * `SetupInitialAdminUseCase` re-runs idempotently. Keyed by id; a secondary
 * lookup by username scans the map.
 */
export class InMemoryUserRepository implements IUserRepository {
  private readonly users = new Map<string, User>();

  public async findByUsername(username: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.username.value === username) return user;
    }
    return null;
  }

  public async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  public async save(user: User): Promise<void> {
    this.users.set(user.id.value, user);
  }

  public async deleteById(id: string): Promise<void> {
    this.users.delete(id);
  }

  public async list(): Promise<UserSummary[]> {
    return [...this.users.values()]
      .sort((a, b) => a.createdAt - b.createdAt || a.username.value.localeCompare(b.username.value))
      .map((u) => ({
        id: u.id.value,
        username: u.username.value,
        role: u.role,
        createdAt: u.createdAt,
      }));
  }

  public async countByRole(role: Role): Promise<number> {
    let count = 0;
    for (const user of this.users.values()) {
      if (user.role === role) count++;
    }
    return count;
  }

  /** Test/dev helper: clears the store (mirrors the other in-memory repos). */
  public clear(): void {
    this.users.clear();
  }
}