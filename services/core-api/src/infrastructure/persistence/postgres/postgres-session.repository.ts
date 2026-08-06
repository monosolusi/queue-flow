import type { Pool } from 'pg';
import {
  type ActiveSession,
  type ISessionRepository,
} from '../../../domain/identity';
import { withDbClient } from './transaction-context';

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
}

/**
 * PostgreSQL {@link ISessionRepository} (QUE-43). Stores only the SHA-256
 * `token_hash` (never the raw token). `findActiveByTokenHash` filters
 * `expires_at > now` so an expired session is treated as invalid (the guard
 * maps that to 401); `deleteExpired` is the maintenance sweep. `deleteByUserId`
 * is the explicit revoke-on-user-delete (the `ON DELETE CASCADE` is the durable
 * backstop). Enlists on the ambient transaction client via {@link withDbClient}.
 */
export class PostgresSessionRepository implements ISessionRepository {
  constructor(private readonly pool: Pool) {}

  public async create(params: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: number;
  }): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
        [params.id, params.userId, params.tokenHash, params.expiresAt],
      );
    });
  }

  public async findActiveByTokenHash(tokenHash: string, now: number): Promise<ActiveSession | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<SessionRow>(
        'SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > $2',
        [tokenHash, now],
      );
      return rows[0]
        ? { id: rows[0].id, userId: rows[0].user_id, expiresAt: Number(rows[0].expires_at) }
        : null;
    });
  }

  public async deleteByTokenHash(tokenHash: string): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    });
  }

  public async deleteByUserId(userId: string): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    });
  }

  public async deleteExpired(now: number): Promise<number> {
    return withDbClient(this.pool, async (client) => {
      const { rowCount } = await client.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
      return Number(rowCount ?? 0);
    });
  }
}