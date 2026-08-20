import {
  type ILicenseRepository,
  type StoredLicense,
} from '../../../domain/licensing/repositories/license.repository';
import { Identifier } from '../../../domain/shared/identifier';

/**
 * In-memory {@link ILicenseRepository} for unit tests and local dev
 * (LSP-interchangeable with the Postgres concretion). Keeps history and the
 * single-active invariant, so a test that activates twice sees the same
 * behaviour the partial unique index enforces in Postgres.
 */
export class InMemoryLicenseRepository implements ILicenseRepository {
  private readonly rows: StoredLicense[] = [];

  public async getActive(): Promise<StoredLicense | null> {
    return this.rows.find((row) => row.isActive) ?? null;
  }

  public async activate(token: string, installedBy: string): Promise<StoredLicense> {
    for (let i = 0; i < this.rows.length; i += 1) {
      if (this.rows[i].isActive) {
        this.rows[i] = { ...this.rows[i], isActive: false };
      }
    }
    const row: StoredLicense = {
      id: Identifier.generate().toString(),
      token,
      installedAt: new Date(),
      installedBy,
      isActive: true,
    };
    this.rows.unshift(row);
    return row;
  }

  public async history(): Promise<StoredLicense[]> {
    return [...this.rows].sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime());
  }

  public clear(): void {
    this.rows.length = 0;
  }
}
