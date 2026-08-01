/**
 * Thrown by {@link PostgresDurabilityProbe} at boot when the PostgreSQL server
 * does not satisfy the durability contract required by NFR-REL-02 (no
 * duplicate / lost ticket numbers after a power cut).
 *
 * `fsync` is a `postmaster`-context GUC: it cannot be set per-session, only at
 * server restart. When it is `off`, committed writes are not guaranteed to
 * survive a crash, so the app refuses to start rather than run in a mode that
 * could silently gap or lose ticket numbers — fail-fast is the correct posture
 * for a hard reliability constraint.
 *
 * Infrastructure only — a startup/IO concern; it does not leak into the domain
 * (NFR-MNT-01). Plain `Error` subclass, like the migration runner's checksum
 * error; Nest surfaces it during `OnModuleInit` as a fatal boot failure.
 */
export class DurabilityDegradedException extends Error {
  constructor(setting: string, value: string) {
    super(
      `Durability contract violated: ${setting}=${value}. NFR-REL-02 requires ${setting}=on so committed ticket writes survive a power cut. ` +
        `Restart PostgreSQL with ${setting}=on (server-level GUC — cannot be set per-session).`,
    );
    this.name = DurabilityDegradedException.name;
    Object.setPrototypeOf(this, DurabilityDegradedException.prototype);
  }
}