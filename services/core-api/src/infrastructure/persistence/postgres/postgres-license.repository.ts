import type { Pool } from 'pg';

import {
  type ILicenseRepository,
  type StoredLicense,
} from '../../../domain/licensing/repositories/license.repository';
import { Identifier } from '../../../domain/shared/identifier';
import { withDbClient } from './transaction-context';

interface LicenseRow {
  id: string;
  token: string;
  installed_at: Date;
  installed_by: string;
  is_active: boolean;
}

const toStored = (row: LicenseRow): StoredLicense => ({
  id: row.id,
  token: row.token,
  installedAt: row.installed_at,
  installedBy: row.installed_by,
  isActive: row.is_active,
});

/**
 * PostgreSQL {@link ILicenseRepository}. History is append-only: rows are
 * deactivated, never deleted or overwritten, because "which license was active
 * when" is the question a billing dispute asks and an offline product has no
 * server-side record to fall back on.
 */
export class PostgresLicenseRepository implements ILicenseRepository {
  constructor(private readonly pool: Pool) {}

  public async getActive(): Promise<StoredLicense | null> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `SELECT id, token, installed_at, installed_by, is_active
           FROM licenses WHERE is_active LIMIT 1`,
      );
      return rows[0] ? toStored(rows[0]) : null;
    });
  }

  /**
   * Deactivate-then-insert: two statements that MUST commit as one.
   *
   * `withDbClient` only ENLISTS on an ambient transaction — it does not open
   * one — so the caller owns the boundary, exactly like the gap-free sequence
   * reservation (QUE-30). `ActivateLicenseUseCase` wraps this in
   * `ITransactionManager.runInTransaction`. Without that, the two statements
   * autocommit separately and a crash in between leaves the store with NO
   * active license moments after a successful upload — the store would go
   * RESTRICTED because it activated correctly (NFR-REL-02).
   *
   * Not folded into one data-modifying CTE: sub-statements there share a
   * snapshot and cannot see one another's effects, so the old row would still
   * look active to the new row's unique-index check.
   */
  public async activate(token: string, installedBy: string): Promise<StoredLicense> {
    return withDbClient(this.pool, async (client) => {
      await client.query('UPDATE licenses SET is_active = FALSE WHERE is_active');
      const { rows } = await client.query<LicenseRow>(
        `INSERT INTO licenses (id, token, installed_at, installed_by, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, token, installed_at, installed_by, is_active`,
        [Identifier.generate().toString(), token, new Date(), installedBy],
      );
      return toStored(rows[0]);
    });
  }

  public async history(): Promise<StoredLicense[]> {
    return withDbClient(this.pool, async (client) => {
      const { rows } = await client.query<LicenseRow>(
        `SELECT id, token, installed_at, installed_by, is_active
           FROM licenses ORDER BY installed_at DESC`,
      );
      return rows.map(toStored);
    });
  }
}
