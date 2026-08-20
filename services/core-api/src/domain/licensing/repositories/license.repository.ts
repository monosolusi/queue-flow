export const LICENSE_REPOSITORY = Symbol('LICENSE_REPOSITORY');

/** A licence token as stored, with the provenance of its installation. */
export interface StoredLicense {
  readonly id: string;
  /** The armored token exactly as uploaded — the signed bytes, never re-encoded. */
  readonly token: string;
  readonly installedAt: Date;
  /** Authenticated principal's username, or `'system'` on the pre-setup path. */
  readonly installedBy: string;
  readonly isActive: boolean;
}

/**
 * Licence storage. History is retained rather than overwritten: which licence
 * was active when is exactly the question a billing dispute asks, and there is
 * no server-side record to fall back on.
 */
export interface ILicenseRepository {
  /** The currently active licence, or `null` on a store that has never activated. */
  getActive(): Promise<StoredLicense | null>;
  /** Stores `token` as active and deactivates the previous one, atomically. */
  activate(token: string, installedBy: string): Promise<StoredLicense>;
  /** Newest first. */
  history(): Promise<StoredLicense[]>;
}
