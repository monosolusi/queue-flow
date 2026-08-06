import {
  type ActiveSession,
  type ISessionRepository,
} from '../../../domain/identity';

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

/**
 * In-memory {@link ISessionRepository} for unit/integration tests and local dev
 * (LSP-interchangeable with {@link PostgresSessionRepository}). Stores only the
 * `tokenHash` (never the raw token — mirrors the Postgres contract). Expiry is
 * enforced in `findActiveByTokenHash` against the passed `now` (the guard
 * supplies the clock), so expired sessions are skipped just like the Postgres
 * `expires_at > now` filter.
 */
export class InMemorySessionRepository implements ISessionRepository {
  private readonly sessions = new Map<string, SessionRow>();

  public async create(params: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: number;
  }): Promise<void> {
    this.sessions.set(params.tokenHash, {
      id: params.id,
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
    });
  }

  public async findActiveByTokenHash(tokenHash: string, now: number): Promise<ActiveSession | null> {
    const row = this.sessions.get(tokenHash);
    if (!row || row.expiresAt <= now) return null;
    return { id: row.id, userId: row.userId, expiresAt: row.expiresAt };
  }

  public async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  public async deleteByUserId(userId: string): Promise<void> {
    for (const [hash, row] of this.sessions) {
      if (row.userId === userId) this.sessions.delete(hash);
    }
  }

  public async deleteExpired(now: number): Promise<number> {
    let count = 0;
    for (const [hash, row] of this.sessions) {
      if (row.expiresAt <= now) {
        this.sessions.delete(hash);
        count++;
      }
    }
    return count;
  }

  /** Test/dev helper: clears the store (mirrors the other in-memory repos). */
  public clear(): void {
    this.sessions.clear();
  }
}