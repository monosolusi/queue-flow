import type { User } from '../user.entity';
import type { Role } from '../value-objects/role';

/**
 * NestJS DI token for {@link IUserRepository}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so domain
 * purity (NFR-MNT-01) holds. Mirrors the other repo-port tokens.
 */
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

/** Minimal projection returned by {@link IUserRepository.list} / `count`. */
export interface UserSummary {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
}

/**
 * Repository port for the Identity bounded context (DIP). The application layer
 * depends on this abstraction; infrastructure supplies the concrete impl (an
 * in-memory Map for tests/dev, PostgreSQL for production). `save` is an
 * upsert (create-or-update by id) so `SetupInitialAdminUseCase` can re-run
 * idempotently on a failed first-run. `findByUsername` is the login lookup.
 */
export interface IUserRepository {
  findByUsername(username: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  /** Create or update by id (upsert). */
  save(user: User): Promise<void>;
  deleteById(id: string): Promise<void>;
  list(): Promise<UserSummary[]>;
  /** Count of users with a given role (used by the last-admin-delete guard). */
  countByRole(role: Role): Promise<number>;
}