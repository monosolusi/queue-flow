import type { Pool } from 'pg';

import {
  type IInstallationRepository,
  type InstallationRecord,
} from '../../../domain/licensing/repositories/installation.repository';
import {
  installationIdGenerate,
  installationIdOf,
} from '../../../domain/licensing/value-objects/installation-id';
import { SYSTEM_AGGREGATE_ID } from '../../../domain/shared/system-aggregate-id';
import { withDbClient } from './transaction-context';

interface InstallationRow {
  installation_id: string;
  created_at: Date;
  last_seen_at: Date;
  host_mismatch_since: Date | null;
}

/**
 * PostgreSQL {@link IInstallationRepository}. Singleton row, keyed by the same
 * `SYSTEM_AGGREGATE_ID` sentinel the system configuration uses.
 */
export class PostgresInstallationRepository implements IInstallationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Creating this row is the moment the deployment acquires the identity every
   * license is issued against, so it must be idempotent under a concurrent
   * boot. `ON CONFLICT DO NOTHING` followed by an unconditional read means two
   * racing boots agree on one id instead of one of them silently minting a
   * second — which would invalidate a license issued moments earlier.
   */
  public async getOrCreate(now: Date): Promise<InstallationRecord> {
    return withDbClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO installation (id, installation_id, created_at, last_seen_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [SYSTEM_AGGREGATE_ID, installationIdGenerate().toString(), now],
      );
      const { rows } = await client.query<InstallationRow>(
        `SELECT installation_id, created_at, last_seen_at, host_mismatch_since
           FROM installation WHERE id = $1`,
        [SYSTEM_AGGREGATE_ID],
      );
      const row = rows[0];
      if (row === undefined) {
        // Unreachable in practice — the INSERT above either created the row or
        // found it already there. Guarded anyway because the alternative is a
        // TypeError on the boot path, which crash-loops the container under
        // `restart: always` and reads as a database outage rather than a bug.
        throw new Error('installation row missing immediately after upsert');
      }
      return {
        installationId: installationIdOf(row.installation_id),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        hostMismatchSince: row.host_mismatch_since,
      };
    });
  }

  /**
   * `GREATEST` in SQL rather than a read-compare-write in TypeScript: the
   * high-water mark must never move backwards, and doing the comparison in the
   * database keeps that true under concurrent writers without a transaction.
   */
  public async touch(seenAt: Date): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(
        `UPDATE installation SET last_seen_at = GREATEST(last_seen_at, $2) WHERE id = $1`,
        [SYSTEM_AGGREGATE_ID, seenAt],
      );
    });
  }

  public async setHostMismatchSince(since: Date | null): Promise<void> {
    await withDbClient(this.pool, async (client) => {
      await client.query(`UPDATE installation SET host_mismatch_since = $2 WHERE id = $1`, [
        SYSTEM_AGGREGATE_ID,
        since,
      ]);
    });
  }
}
