/**
 * NestJS DI token for {@link ISessionRepository}. Interfaces are erased at
 * runtime, so the application layer injects the port by this Symbol rather than
 * by type metadata. A plain language builtin — no framework import — so domain
 * purity (NFR-MNT-01) holds.
 */
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

/** Active-session lookup result (the guard resolves the user from `userId`). */
export interface ActiveSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: number;
}

/**
 * Repository port for opaque session tokens (QUE-43). The raw token is never
 * stored — only its SHA-256 `tokenHash` is persisted, so a DB leak cannot
 * authenticate a session. `findActiveByTokenHash` is the per-request lookup the
 * `AuthGuard` uses (an indexed PK hit, well within the p99<100ms budget).
 *
 * Sessions are created on login and deleted on logout (real revocation — the
 * advantage of server-side sessions over stateless JWT). `deleteByUserId`
 * cleans up when a user is deleted; `deleteExpired` is a maintenance sweep.
 */
export interface ISessionRepository {
  create(params: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: number;
  }): Promise<void>;
  findActiveByTokenHash(tokenHash: string, now: number): Promise<ActiveSession | null>;
  deleteByTokenHash(tokenHash: string): Promise<void>;
  deleteByUserId(userId: string): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}