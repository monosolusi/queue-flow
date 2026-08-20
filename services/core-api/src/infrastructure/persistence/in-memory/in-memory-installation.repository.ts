import {
  type IInstallationRepository,
  type InstallationRecord,
} from '../../../domain/licensing/repositories/installation.repository';
import { installationIdGenerate } from '../../../domain/licensing/value-objects/installation-id';

/**
 * In-memory {@link IInstallationRepository} for unit tests and local dev
 * (LSP-interchangeable with the Postgres concretion).
 *
 * Note the consequence for dev: the installation id is regenerated on every
 * restart, so a license issued against it stops matching. That is correct
 * behaviour for a store with no persistence, not a bug to work around — use
 * `QMS_PERSISTENCE=postgres` to exercise a stable identity.
 */
export class InMemoryInstallationRepository implements IInstallationRepository {
  private record: InstallationRecord | null = null;

  public async getOrCreate(now: Date): Promise<InstallationRecord> {
    if (this.record === null) {
      this.record = {
        installationId: installationIdGenerate(),
        createdAt: now,
        lastSeenAt: now,
        hostMismatchSince: null,
      };
    }
    return this.record;
  }

  public async touch(seenAt: Date): Promise<void> {
    if (this.record === null) return;
    // Never moves backwards — this is the clock-rollback high-water mark.
    if (seenAt.getTime() > this.record.lastSeenAt.getTime()) {
      this.record = { ...this.record, lastSeenAt: seenAt };
    }
  }

  public async setHostMismatchSince(since: Date | null): Promise<void> {
    if (this.record === null) return;
    this.record = { ...this.record, hostMismatchSince: since };
  }

  /** Test-only reset, mirroring the other in-memory repos' `clear()`. */
  public clear(): void {
    this.record = null;
  }
}
