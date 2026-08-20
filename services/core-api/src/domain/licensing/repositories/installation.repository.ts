import type { InstallationId } from '../value-objects/installation-id';

export const INSTALLATION_REPOSITORY = Symbol('INSTALLATION_REPOSITORY');

export interface InstallationRecord {
  readonly installationId: InstallationId;
  readonly createdAt: Date;
  /**
   * Monotonic high-water mark of observed time. Offline boxes have no NTP, so
   * the wall clock is the customer's to set; comparing expiry against
   * `max(now, lastSeenAt)` means winding it back cannot revive a lapsed trial.
   */
  readonly lastSeenAt: Date;
  /**
   * When a host mismatch was first observed, or `null` while the host matches.
   * The grace window is anchored here because a licence cannot know when the
   * hardware changed — only the installation can observe it.
   */
  readonly hostMismatchSince: Date | null;
}

export interface IInstallationRepository {
  /**
   * The singleton installation record, created on first call. Creation is the
   * moment this installation acquires the identity every licence is issued
   * against, so it must be idempotent under a concurrent boot.
   */
  getOrCreate(now: Date): Promise<InstallationRecord>;
  /** Advances `lastSeenAt` if `seenAt` is later; never moves it backwards. */
  touch(seenAt: Date): Promise<void>;
  setHostMismatchSince(since: Date | null): Promise<void>;
}
